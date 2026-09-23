import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, AppState, Alert, Linking } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, Region } from "react-native-maps";
import * as Location from "expo-location";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  RootStackParamList,
  SegmentSummary,
  LatLng,
  PresenceUser,
  MapBounds,
  RaceDistanceKey,
  RaceDirectionKey,
  RaceChallenge,
  BusyDrive,
} from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { useProximityVoiceContext } from "../context/ProximityVoiceContext";
import { cumulativeDistances, projectOntoPolyline, pointAtDistance, haversine } from "../utils/geo";
import { displaySpeedKmh, speedUnit, formatDistanceShort, formatDistanceLong } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
import { RACE_DISTANCES } from "../raceDistances";
import { RACE_DIRECTIONS } from "../raceDirections";
import { recordSpeed, flushTopSpeed } from "../topSpeed";
import NeonButton from "../components/NeonButton";
import VehicleMarker from "../components/VehicleMarker";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

// How close a segment's nearest point has to be to your current position to
// count as "nearby" and show up on the live map. 5km covers "the road I'm
// about to drive" without cluttering the map with the whole city.
const NEARBY_RADIUS_M = 5000;

// Auto-detect racing: if you're moving at least this fast, you're clearly
// driving (not walking or stopped), and if you're within this many meters
// of a track's start line at that moment, jump straight into timing that
// track -- no need to open its card and tap "Race it" first.
const AUTO_START_SPEED_KMH = 15;
const AUTO_START_RADIUS_M = 45;

const FALLBACK_REGION: Region = {
  latitude: 14.6349,
  longitude: -90.5069,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// How often to heartbeat our own position and refresh who else is visible.
// Matches the server's PRESENCE_MAX_AGE_MS (25s) with room to spare, so one
// missed tick (a brief network blip) doesn't make anyone's marker vanish.
const HEARTBEAT_INTERVAL_MS = 5000;

type NearbySegment = SegmentSummary & { distanceM: number };

// The visible map region -> a lat/lng box, for the presence query. This is
// what makes one query naturally cover both "who's near me" (the initial
// region, centered on you) and "who's over there" (after panning/zooming to
// look at another city or country) -- the app just always asks for whoever
// is inside whatever's currently on screen.
function regionToBounds(region: Region): MapBounds {
  const north = Math.min(90, region.latitude + region.latitudeDelta / 2);
  const south = Math.max(-90, region.latitude - region.latitudeDelta / 2);
  const normalizeLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
  return {
    north,
    south,
    east: normalizeLng(region.longitude + region.longitudeDelta / 2),
    west: normalizeLng(region.longitude - region.longitudeDelta / 2),
  };
}

// The home screen: mostly map. You see yourself (the blue dot), your live
// speed, and any recorded tracks close enough to be worth racing right now.
// Browsing the full list of every track ever recorded lives one tap away
// (the "All tracks" button), since that's a secondary, occasional action.
export default function HomeScreen({ navigation, route }: Props) {
  const { user, vehicleStyle, incognito, voiceEnabled, units, showTracks, setShowTracks } = useUser();
  // Set when this Home was opened *on top of* a drive or race that's still
  // running underneath (the MAP button on those screens pushes it here), so
  // you can look around without ending what you were doing. Going back drops
  // you straight back into it. While it's set, anything that would start a
  // second drive is hidden -- you can't record two things at once.
  const busy: BusyDrive | null = route.params?.busy ?? null;
  const busyRef = useRef<BusyDrive | null>(null);
  busyRef.current = busy;
  const { reportPosition, connectedPeers, talking, setTalking, micReady, micBlocked, retryMic } =
    useProximityVoiceContext();
  const [blocking, setBlocking] = useState(false);

  // Where the map opens. null until we've checked for a cached fix, so the
  // map never mounts on the hardcoded fallback when we could have opened it
  // on you instead (initialRegion is only read once, at mount).
  const [initialRegion, setInitialRegion] = useState<Region | null>(null);
  // Why you might not be on the map: permission not granted yet / denied /
  // denied with "don't ask again" / phone's location services switched off.
  // Drives the banner under the top bar that explains it and fixes it.
  const [locationStatus, setLocationStatus] = useState<"checking" | "granted" | "denied" | "blocked" | "servicesOff">(
    "checking"
  );
  // Bumped by the banner's button to re-run the location setup below.
  const [locationRetry, setLocationRetry] = useState(0);

  // Map-overlay redraw counter. On Android (new architecture), when another
  // screen is pushed on top of Home and you come back -- e.g. Account to
  // flip incognito -- the native map can silently drop the markers and
  // polylines drawn on it, even though React still thinks they're there:
  // you and the tracks "disappear" while "N tracks nearby" still counts
  // them. Bumping this on every return re-keys every overlay, so React
  // unmounts and re-adds them to the map from scratch.
  const [overlayEpoch, setOverlayEpoch] = useState(0);
  // Custom-view markers are snapshotted to a bitmap; with
  // tracksViewChanges off, a snapshot taken before the SVG finished drawing
  // stays blank forever. Keep tracking on briefly after each redraw, then
  // turn it off again (leaving it on costs battery/perf).
  const [markersSettled, setMarkersSettled] = useState(false);
  const focusCountRef = useRef(0);
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);

  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [userPos, setUserPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Other signed-in users currently visible on the map (see the presence
  // heartbeat/query effect below) -- who's shown depends only on what's
  // inside the current map region, not a fixed "nearby" radius like tracks.
  const [otherUsers, setOtherUsers] = useState<PresenceUser[]>([]);

  // Live race challenges -- tapping a nearby player's marker selects them
  // (mirrors selectedId/selected for tracks, just for people instead of
  // roads); raceStep drives what the selected-player card shows next.
  const [selectedUser, setSelectedUser] = useState<PresenceUser | null>(null);
  const [raceStep, setRaceStep] = useState<"closed" | "distance" | "direction" | "waiting">("closed");
  // Distance picked in the first step, held while they choose a direction.
  const [pendingDistanceKey, setPendingDistanceKey] = useState<RaceDistanceKey | null>(null);
  const [creatingChallenge, setCreatingChallenge] = useState(false);
  const [pendingRaceId, setPendingRaceId] = useState<string | null>(null);
  const [pendingDistanceLabel, setPendingDistanceLabel] = useState<string | null>(null);
  const [raceError, setRaceError] = useState<string | null>(null);
  // A race request someone else sent *to* us -- surfaced as its own overlay
  // regardless of what else is selected, since it can arrive at any time.
  const [incomingRace, setIncomingRace] = useState<RaceChallenge | null>(null);
  const [respondingIncoming, setRespondingIncoming] = useState(false);
  // Racer picker (from the HUD's "N racers on the map" line), for when
  // there's more than one to choose between.
  const [pickingRacer, setPickingRacer] = useState(false);

  // Whether the map should keep recentering on you as you move. On by
  // default (that's the whole point of this fix -- your position marker
  // used to drift out of view within a few seconds of driving). Turned off
  // the moment you drag the map yourself (onPanDrag, below) so looking
  // around isn't fought every second by an auto-recenter; the recenter
  // button turns it back on. A ref, not state, because it's read from
  // inside the location-watcher closure set up in useFocusEffect.
  const followRef = useRef(true);

  // Presence (live location sharing) plumbing. All refs, not state, because
  // sendHeartbeatTick/refreshPresence are called from a setInterval set up
  // once per screen-focus (see useFocusEffect below) as well as directly
  // from onRegionChangeComplete -- reading these through refs means neither
  // callback needs to be recreated (and the interval torn down/restarted)
  // every time position, incognito, or the signed-in user changes.
  const latestPosRef = useRef<{ coords: LatLng; heading: number | null } | null>(null);
  const incognitoRef = useRef(incognito);
  const voiceEnabledRef = useRef(voiceEnabled);
  const userRef = useRef(user);
  const regionRef = useRef<Region>(FALLBACK_REGION);
  const presenceInFlightRef = useRef(false);
  const heartbeatInFlightRef = useRef(false);
  const racesInFlightRef = useRef(false);

  useEffect(() => {
    incognitoRef.current = incognito;
  }, [incognito]);
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Tells the backend "I'm here" (or "I'm here, but hidden" if incognito is
  // on) -- see the visibility model this implements: live to others for as
  // long as these keep arriving, invisible again shortly after they stop
  // (backgrounding the app, losing signal, or closing it), no explicit
  // "I'm leaving" call needed. Best-effort: a dropped heartbeat just means
  // this one tick didn't update your position, not an error worth surfacing.
  const sendHeartbeatTick = useCallback(() => {
    const deviceId = userRef.current?.deviceId;
    const pos = latestPosRef.current;
    // Skip if the last one hasn't come back yet, so slow ones can't stack
    // up and hog the phone's limited connections to the server.
    if (!deviceId || !pos || heartbeatInFlightRef.current || AppState.currentState !== "active") return;
    heartbeatInFlightRef.current = true;
    api
      .sendHeartbeat(deviceId, pos.coords, pos.heading, incognitoRef.current, voiceEnabledRef.current)
      .catch(() => {})
      .finally(() => {
        heartbeatInFlightRef.current = false;
      });
  }, []);

  // Refreshes who else is visible in the current map region. Independent of
  // our own incognito state and of having a GPS fix yet -- seeing others
  // doesn't require broadcasting yourself.
  const refreshPresence = useCallback(async () => {
    const deviceId = userRef.current?.deviceId;
    if (!deviceId || presenceInFlightRef.current) return;
    presenceInFlightRef.current = true;
    try {
      const { users } = await api.queryPresence(deviceId, regionToBounds(regionRef.current));
      setOtherUsers(users);
    } catch {
      // Keep the last-known list rather than flashing an error over what's
      // just a background refresh.
    } finally {
      presenceInFlightRef.current = false;
    }
  }, []);

  // Polls for race requests addressed to us. Piggybacks on the same cadence
  // as presence (see the focus-effect interval below) rather than a second
  // timer. Never clobbers a challenge already on screen -- if the driver is
  // mid-decision on one, a newer one just waits for the next tick after they
  // resolve it, instead of yanking the card out from under them.
  const refreshIncomingRaces = useCallback(async () => {
    const deviceId = userRef.current?.deviceId;
    if (!deviceId || racesInFlightRef.current) return;
    racesInFlightRef.current = true;
    try {
      const incoming = await api.getIncomingRaceChallenges(deviceId);
      setIncomingRace((current) => (current ? current : incoming.length > 0 ? incoming[0] : null));
    } catch {
      // Best-effort, same as presence -- next tick retries.
    } finally {
      racesInFlightRef.current = false;
    }
  }, []);

  const loadSegments = useCallback(async () => {
    try {
      setError(null);
      // deviceId included so your own private tracks show up here too --
      // see the "private tracks" feature.
      const data = await api.listSegments(userRef.current?.deviceId);
      setSegments(data);
    } catch (e: any) {
      setError(e.message || "Couldn't reach the backend.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Track position + speed only while this screen is actually on screen --
  // Home stays mounted underneath every pushed screen in the stack, so a
  // plain mount-effect would keep GPS running (and draining battery) the
  // whole time you're recording a run or looking at a leaderboard.
  useFocusEffect(
    useCallback(() => {
      focusCountRef.current += 1;
      // First focus is the initial mount -- nothing to redraw yet. After
      // that, redraw once the screen is actually back (the native view is
      // re-attached slightly after the focus event fires).
      const redrawTimer =
        focusCountRef.current > 1 ? setTimeout(() => setOverlayEpoch((n) => n + 1), 300) : null;
      loadSegments();
      let cancelled = false;
      let autoStarted = false;

      // `live` is false for the cached last-known fix we show immediately --
      // its speed is stale, so it must not drive the speed HUD or trigger
      // auto-start racing.
      const applyLocation = (loc: Location.LocationObject, live: boolean) => {
        const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setUserPos(pos);
        // heading is -1 (or null on some devices) when the compass
        // reading isn't reliable yet, e.g. standing still -- keep
        // pointing the last known direction instead of snapping to
        // north.
        const validHeading = loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : null;
        if (validHeading != null) {
          setHeading(validHeading);
        }
        latestPosRef.current = { coords: pos, heading: validHeading };
        reportPosition(pos, validHeading);

        if (followRef.current) {
          // Tighter than the old 0.02 so turns on small roads/blocks
          // are easier to spot while driving.
          mapRef.current?.animateToRegion(
            { latitude: pos.lat, longitude: pos.lng, latitudeDelta: 0.008, longitudeDelta: 0.008 },
            500
          );
        }

        if (!live) return;
        const currentSpeedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
        setSpeedKmh(currentSpeedKmh);
        // Your top speed counts whenever the app is open, not just during a
        // recorded drive -- this is the "just driving around" case.
        recordSpeed(currentSpeedKmh);

        // Guarded to fire at most once per visit to this screen, so it
        // can't re-trigger every second while sitting still right at a
        // start line -- only an actual approach at driving speed counts.
        // Never while something else is already recording underneath.
        if (!busyRef.current && !autoStarted && currentSpeedKmh >= AUTO_START_SPEED_KMH) {
          const candidate = nearbyRef.current.find(
            (s) => s.points.length >= 2 && haversine(pos, s.points[0]) <= AUTO_START_RADIUS_M
          );
          if (candidate) {
            autoStarted = true;
            navigation.navigate("RecordRun", { segmentId: candidate.id, autoStart: true });
          }
        }
      };

      (async () => {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (perm.status !== "granted") {
          // Previously this just returned silently, leaving the map parked
          // on the fallback with no hint why you weren't on it.
          setLocationStatus(perm.canAskAgain ? "denied" : "blocked");
          return;
        }
        try {
          if (!(await Location.hasServicesEnabledAsync())) {
            if (!cancelled) setLocationStatus("servicesOff");
            return;
          }
        } catch {
          // Can't tell -- carry on and let the watcher below find out.
        }
        if (cancelled) return;
        setLocationStatus("granted");

        // Put you on the map right away from the phone's cached fix, rather
        // than waiting (sometimes a long while, indoors) for the first fresh
        // GPS reading from the watcher below.
        try {
          const last = await Location.getLastKnownPositionAsync({});
          if (last && !cancelled) applyLocation(last, false);
        } catch {}
        if (cancelled) return;

        try {
          const sub = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 5 },
            (loc) => applyLocation(loc, true)
          );
          if (cancelled) {
            sub.remove();
          } else {
            subscriptionRef.current = sub;
          }
        } catch {
          if (!cancelled) setLocationStatus("servicesOff");
        }
      })();

      // Presence: one immediate tick so markers/your own visibility don't
      // wait a full interval on first focus, then every HEARTBEAT_INTERVAL_MS
      // for as long as this screen stays focused.
      sendHeartbeatTick();
      refreshPresence();
      refreshIncomingRaces();
      const presenceTimer = setInterval(() => {
        sendHeartbeatTick();
        refreshPresence();
        refreshIncomingRaces();
      }, HEARTBEAT_INTERVAL_MS);

      return () => {
        cancelled = true;
        if (redrawTimer) clearTimeout(redrawTimer);
        subscriptionRef.current?.remove();
        subscriptionRef.current = null;
        clearInterval(presenceTimer);
        // Don't sit on a personal best set in the last few seconds while
        // you wander off to another screen (or close the app from here).
        flushTopSpeed();
      };
    }, [loadSegments, navigation, sendHeartbeatTick, refreshPresence, refreshIncomingRaces, reportPosition, locationRetry])
  );

  // Pick where the map opens, before it mounts: the phone's cached position
  // if we already have location permission, else the fallback (in which
  // case the focus effect above asks for permission and moves the map to
  // you as soon as it gets a fix). Only checks permission -- never prompts
  // -- so it can't collide with the focus effect's own permission request.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let region = FALLBACK_REGION;
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status === "granted") {
          const last = await Location.getLastKnownPositionAsync({});
          if (last) {
            region = {
              latitude: last.coords.latitude,
              longitude: last.coords.longitude,
              latitudeDelta: 0.008,
              longitudeDelta: 0.008,
            };
          }
        }
      } catch {}
      if (cancelled) return;
      regionRef.current = region;
      setInitialRegion(region);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Same redraw when the app comes back from the background (switching
  // apps, locking the phone), which can drop map overlays the same way.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") setTimeout(() => setOverlayEpoch((n) => n + 1), 300);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    setMarkersSettled(false);
    const t = setTimeout(() => setMarkersSettled(true), 1500);
    return () => clearTimeout(t);
  }, [overlayEpoch]);

  const fixLocation = async () => {
    if (locationStatus === "blocked") {
      Linking.openSettings();
      return;
    }
    if (locationStatus === "servicesOff") {
      try {
        // Android shows its own "turn on location" dialog for this.
        await Location.enableNetworkProviderAsync();
      } catch {
        // User said no, or not supported -- the retry below will just
        // land back on the same banner.
      }
    }
    setLocationStatus("checking");
    setLocationRetry((n) => n + 1);
  };

  const onMicUnavailable = () => {
    if (micBlocked) {
      Alert.alert(
        "Microphone is off",
        "Phantom Racing isn't allowed to use your microphone. Turn it on in the app's settings to use push-to-talk.",
        [
          { text: "Not now", style: "cancel" },
          { text: "Open settings", onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }
    retryMic();
  };

  // Polls the race we just challenged someone to, waiting for them to
  // accept/decline (or for it to time out). Only runs while we have an
  // outstanding request -- pendingRaceId is cleared the moment it resolves,
  // which tears this effect down rather than leaving a dangling interval.
  useEffect(() => {
    if (!pendingRaceId || !user) return;
    let cancelled = false;
    const deviceId = user.deviceId;
    const raceId = pendingRaceId;
    const tick = async () => {
      try {
        const updated = await api.getRaceChallenge(raceId, deviceId);
        if (cancelled) return;
        if (updated.status === "accepted") {
          setPendingRaceId(null);
          setRaceStep("closed");
          setSelectedUser(null);
          navigation.navigate("RaceLive", { raceId: updated.id });
        } else if (updated.status !== "pending") {
          setPendingRaceId(null);
          setRaceStep("closed");
          setRaceError(
            updated.status === "declined"
              ? `${updated.opponentDisplayName} declined the race.`
              : updated.status === "expired"
              ? "Race request expired -- they didn't respond in time."
              : "Race request was cancelled."
          );
        }
      } catch {
        // Transient network hiccup -- next tick retries.
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pendingRaceId, user, navigation]);

  const nearby: NearbySegment[] = useMemo(() => {
    if (!userPos) return [];
    return segments
      .map((s) => {
        if (s.points.length < 2) return { ...s, distanceM: Infinity };
        const cumDist = cumulativeDistances(s.points);
        const { lateralDistanceM } = projectOntoPolyline(s.points, cumDist, userPos);
        return { ...s, distanceM: lateralDistanceM };
      })
      .filter((s) => s.distanceM <= NEARBY_RADIUS_M)
      .sort((a, b) => a.distanceM - b.distanceM);
  }, [segments, userPos]);

  // The GPS watcher above lives inside useFocusEffect and only sets up its
  // subscription once per focus -- it can't close over a fresh `nearby` on
  // every render the way the JSX below does. This ref keeps it reading the
  // latest nearby-segments list without having to tear down and restart the
  // location subscription whenever that list changes.
  const nearbyRef = useRef<NearbySegment[]>([]);
  useEffect(() => {
    nearbyRef.current = nearby;
  }, [nearby]);

  const selected = nearby.find((s) => s.id === selectedId) ?? null;

  const recenter = () => {
    if (!userPos) return;
    followRef.current = true;
    mapRef.current?.animateToRegion(
      { latitude: userPos.lat, longitude: userPos.lng, latitudeDelta: 0.008, longitudeDelta: 0.008 },
      400
    );
  };

  const formatDistance = (m: number) => `${formatDistanceShort(m, units)} away`;

  const handleSelectDistance = (distanceKey: RaceDistanceKey) => {
    setPendingDistanceKey(distanceKey);
    setRaceStep("direction");
  };

  // Both racers run the same way: only progress in this compass direction
  // counts toward the target distance (see raceDirections.ts).
  const handleSelectDirection = async (directionKey: RaceDirectionKey) => {
    if (!user || !selectedUser || !pendingDistanceKey || creatingChallenge) return;
    setCreatingChallenge(true);
    setRaceError(null);
    try {
      const race = await api.createRaceChallenge(
        user.deviceId,
        selectedUser.deviceId,
        pendingDistanceKey,
        directionKey
      );
      setPendingRaceId(race.id);
      setPendingDistanceLabel(`${race.distanceLabel} ${race.directionLabel}`);
      setRaceStep("waiting");
    } catch (e: any) {
      setRaceError(e.message || "Couldn't send the race request.");
      setRaceStep("closed");
    } finally {
      setCreatingChallenge(false);
    }
  };

  const cancelOutgoingRace = () => {
    if (!user || !pendingRaceId) return;
    const raceId = pendingRaceId;
    setPendingRaceId(null);
    setRaceStep("closed");
    api.cancelRace(raceId, user.deviceId).catch(() => {});
  };

  // Blocking is a voice-only cutoff (see the server's isBlockedPair) -- it
  // stops them showing up as a proximity-voice peer for either of you, but
  // doesn't hide their map marker or stop you racing them; that's a
  // deliberate, narrower scope than a full presence block.
  const onBlockSelected = () => {
    if (!user || !selectedUser) return;
    const target = selectedUser;
    Alert.alert(
      "Block this racer?",
      `${target.displayName} won't be able to voice-chat with you, and you won't hear them either. Undo this anytime from your account screen.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            setBlocking(true);
            try {
              await api.blockPlayer(user.deviceId, target.deviceId);
            } catch {
              // Best-effort -- blocking again from the account screen still
              // works if this particular request dropped.
            } finally {
              setBlocking(false);
              setSelectedUser(null);
              setRaceStep("closed");
            }
          },
        },
      ]
    );
  };

  const respondIncoming = async (accept: boolean) => {
    if (!user || !incomingRace || respondingIncoming) return;
    setRespondingIncoming(true);
    const race = incomingRace;
    try {
      const updated = await api.respondToRaceChallenge(race.id, user.deviceId, accept);
      setIncomingRace(null);
      if (accept) {
        navigation.navigate("RaceLive", { raceId: updated.id });
      }
    } catch {
      setIncomingRace(null);
    } finally {
      setRespondingIncoming(false);
    }
  };

  if (!initialRegion) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  // Everything pinned to the bottom sits above the phone's navigation bar
  // (previously the GO TO / NEW SEGMENT buttons were drawn underneath it).
  const bottomBase = insets.bottom + 16;
  const hudBottom = bottomBase + 68;

  const locationBannerText =
    locationStatus === "denied"
      ? "Location permission is off -- you're not on the map."
      : locationStatus === "blocked"
      ? "Location is blocked for this app -- you're not on the map."
      : locationStatus === "servicesOff"
      ? "Your phone's location (GPS) is turned off."
      : null;
  const locationBannerAction =
    locationStatus === "blocked" ? "OPEN SETTINGS" : locationStatus === "servicesOff" ? "TURN ON" : "ALLOW";

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={initialRegion}
        onMapReady={() => {
          // If a fix already arrived before the map existed (e.g. while the
          // permission prompt was up on first launch), jump to it now --
          // the watcher only fires again after you move ~5m.
          const pos = latestPosRef.current;
          if (pos && followRef.current) {
            mapRef.current?.animateToRegion(
              { latitude: pos.coords.lat, longitude: pos.coords.lng, latitudeDelta: 0.008, longitudeDelta: 0.008 },
              300
            );
          }
        }}
        onPress={() => {
          setSelectedId(null);
          setSelectedUser(null);
          setRaceStep("closed");
          setRaceError(null);
        }}
        onPanDrag={() => {
          followRef.current = false;
        }}
        onRegionChangeComplete={(region) => {
          regionRef.current = region;
          // Refresh right away on top of the periodic tick, so panning to a
          // new area shows who's there without waiting up to
          // HEARTBEAT_INTERVAL_MS for the next scheduled refresh.
          refreshPresence();
        }}
      >
        {userPos && (
          <Marker
            key={`me-${overlayEpoch}`}
            // Below other racers' markers: when someone is right next to you
            // the two overlap, and yours isn't tappable -- it would swallow
            // the tap that's meant to open their RACE card.
            zIndex={1}
            coordinate={{ latitude: userPos.lat, longitude: userPos.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={heading}
            flat
            tracksViewChanges={!markersSettled}
          >
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
        {otherUsers.map((u) => (
          <Marker
            key={`${u.deviceId}-${overlayEpoch}`}
            zIndex={5}
            coordinate={{ latitude: u.lat, longitude: u.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={u.heading ?? 0}
            flat={u.heading != null}
            tracksViewChanges={!markersSettled}
            onPress={() => {
              setSelectedId(null);
              setRaceStep("closed");
              setRaceError(null);
              setPickingRacer(false);
              setSelectedUser(u);
            }}
          >
            <View style={styles.otherUserWrap}>
              <VehicleMarker vehicleStyle="arrow" size={28} color={colors.racePrimary} />
              <View style={styles.otherUserLabel}>
                <Text style={styles.otherUserLabelText} numberOfLines={1}>
                  {u.displayName}
                </Text>
              </View>
            </View>
          </Marker>
        ))}
        {/* Track lines stay mounted even while hidden and are just made
            invisible: on Android, removing a Polyline doesn't always clear it
            from the native map (hiding by unmounting left the lines drawn
            with only their labels gone), while changing its color/width
            always applies. The name labels are Markers, which do remove
            cleanly, so those are simply not rendered while hidden. */}
        {nearby.map((s) => {
          const cumDist = cumulativeDistances(s.points);
          const mid = pointAtDistance(s.points, cumDist, cumDist[cumDist.length - 1] / 2);
          const isSelected = s.id === selectedId;
          return (
            <React.Fragment key={`${s.id}-${overlayEpoch}`}>
              <Polyline
                coordinates={s.points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
                strokeColor={!showTracks ? "rgba(0,0,0,0)" : isSelected ? colors.racePrimary : colors.cyan}
                strokeWidth={!showTracks ? 0 : isSelected ? 6 : 4}
                tappable={showTracks}
                onPress={() => {
                  if (!showTracks) return;
                  setSelectedUser(null);
                  setSelectedId(s.id);
                }}
              />
              {showTracks && (
                <Marker
                  coordinate={{ latitude: mid.lat, longitude: mid.lng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  onPress={() => {
                    setSelectedUser(null);
                    setSelectedId(s.id);
                  }}
                >
                  <View style={[styles.trackLabel, isSelected && styles.trackLabelSelected]}>
                    <Text style={styles.trackLabelText} numberOfLines={1}>
                      {s.name}
                    </Text>
                  </View>
                </Marker>
              )}
            </React.Fragment>
          );
        })}
      </MapView>

      {/* Two rows: your name gets the full width on its own row (it used to
          share one row with three buttons and got cut down to "Fl..."). */}
      <View style={[styles.topBar, { top: insets.top + 10 }]}>
        <Pressable onPress={() => navigation.navigate("Username")} hitSlop={8} style={styles.accountPill}>
          <Text style={styles.accountLabel}>RACER</Text>
          <Text style={styles.topBarName} numberOfLines={1}>
            {user ? user.displayName : "Connecting..."}
          </Text>
          <Text style={styles.accountChevron}>{">"}</Text>
        </Pressable>
        <View style={styles.topBarRow}>
          <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("AllSegments")}>
            <Text style={styles.topBarButtonText} numberOfLines={1}>
              ALL TRACKS
            </Text>
          </Pressable>
          <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("Stats")}>
            <Text style={styles.topBarButtonText} numberOfLines={1}>
              STATS
            </Text>
          </Pressable>
          <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("Welcome")}>
            <Text style={styles.topBarButtonText} numberOfLines={1}>
              HOW IT WORKS
            </Text>
          </Pressable>
        </View>

        {/* Still recording/racing underneath: this Home was pushed on top
            of that screen rather than replacing it, so nothing was stopped
            and going back returns to it exactly where it was. */}
        {busy && (
          <Pressable style={styles.busyBanner} onPress={() => navigation.goBack()}>
            <View style={styles.busyBannerTextWrap}>
              <Text style={styles.busyBannerTitle} numberOfLines={1}>
                {busy.label}
              </Text>
              <Text style={styles.busyBannerSub}>Still running -- nothing was stopped</Text>
            </View>
            <Text style={styles.busyBannerAction}>
              {busy.kind === "race" ? "BACK TO RACE" : "BACK TO IT"} {">"}
            </Text>
          </Pressable>
        )}
        {locationBannerText && (
          <Pressable style={styles.locationBanner} onPress={fixLocation}>
            <Text style={styles.locationBannerText}>{locationBannerText}</Text>
            <Text style={styles.locationBannerAction}>{locationBannerAction}</Text>
          </Pressable>
        )}
        {error && (
          <Pressable
            style={styles.errorBox}
            onPress={() => {
              setLoading(true);
              loadSegments();
            }}
          >
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.errorRetry}>TAP TO RETRY</Text>
          </Pressable>
        )}
      </View>

      {/* Show/hide recorded tracks on the map -- remembered between launches. */}
      <Pressable
        style={[styles.recenterButton, styles.tracksToggle, !showTracks && styles.tracksToggleOff, { bottom: hudBottom + 110 }]}
        onPress={() => {
          if (showTracks) setSelectedId(null);
          setShowTracks(!showTracks);
        }}
        hitSlop={6}
      >
        <Text style={[styles.tracksToggleText, !showTracks && styles.tracksToggleTextOff]}>
          {showTracks ? "TRACKS\nON" : "TRACKS\nOFF"}
        </Text>
      </Pressable>

      <Pressable style={[styles.recenterButton, { bottom: hudBottom + 58 }]} onPress={recenter}>
        <Text style={styles.recenterIcon}>o</Text>
      </Pressable>

      <View style={[styles.speedHud, { bottom: hudBottom }]}>
        {loading ? (
          <ActivityIndicator color={colors.cyan} />
        ) : (
          <>
            <Text style={styles.speedValue}>{displaySpeedKmh(speedKmh, units)}</Text>
            <Text style={styles.speedUnit}>{speedUnit(units)}</Text>
          </>
        )}
        <Text style={styles.nearbyCount}>
          {nearby.length === 0
            ? "No tracks nearby yet"
            : `${nearby.length} track${nearby.length === 1 ? "" : "s"} nearby${showTracks ? "" : " (hidden)"}`}
        </Text>
        {/* Tapping this picks a racer without having to hit their marker --
            markers overlap when someone is right beside you. One racer
            selects them straight away; more than one opens a picker. */}
        {otherUsers.length > 0 && (
          <Pressable
            onPress={() => {
              setSelectedId(null);
              setRaceError(null);
              setRaceStep("closed");
              if (otherUsers.length === 1) {
                setSelectedUser(otherUsers[0]);
              } else {
                setPickingRacer(true);
              }
            }}
            hitSlop={8}
          >
            <Text style={styles.onlineCount}>
              {otherUsers.length} racer{otherUsers.length === 1 ? "" : "s"} on the map {">"}
            </Text>
          </Pressable>
        )}
        {voiceEnabled && connectedPeers.length > 0 && (
          <Text style={styles.voiceCount} numberOfLines={1}>
            Voice: {connectedPeers.map((p) => p.displayName).join(", ")}
          </Text>
        )}
      </View>

      {/* Right-hand side, so it no longer sits on top of the speed HUD. When
          the mic isn't available it's a tap-to-fix button instead of a dead
          one: re-asks for permission, or points to settings if blocked. */}
      {voiceEnabled &&
        (micReady ? (
          <Pressable
            style={[styles.talkButton, { bottom: hudBottom }, talking && styles.talkButtonActive]}
            onPressIn={() => setTalking(true)}
            onPressOut={() => setTalking(false)}
          >
            <Text style={[styles.talkButtonText, talking && styles.talkButtonTextActive]}>
              {talking ? "TALKING..." : "HOLD TO TALK"}
            </Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.talkButton, styles.talkButtonDisabled, { bottom: hudBottom }]} onPress={onMicUnavailable}>
            <Text style={styles.talkButtonText}>TAP TO ENABLE MIC</Text>
          </Pressable>
        ))}

      {selected && showTracks && (
        <View style={[styles.card, { bottom: hudBottom }]}>
          <Pressable style={styles.cardClose} onPress={() => setSelectedId(null)} hitSlop={8}>
            <Text style={styles.cardCloseText}>x</Text>
          </Pressable>
          <Text style={styles.cardTitle}>{selected.name}</Text>
          <Text style={styles.cardMeta}>
            {formatDistance(selected.distanceM)} -- {formatDistanceLong(selected.lengthM, units)}
          </Text>
          <Text style={styles.cardMeta}>
            {selected.bestTimeMs != null
              ? `Best ${(selected.bestTimeMs / 1000).toFixed(1)}s by ${selected.bestTimeUser}`
              : "No runs yet -- be the first"}
          </Text>
          <View style={styles.cardActions}>
            {!busy && (
              <NeonButton
                label="RACE IT"
                onPress={() => navigation.navigate("RecordRun", { segmentId: selected.id })}
                style={styles.cardButton}
              />
            )}
            <NeonButton
              label="LEADERBOARD"
              variant="outline"
              onPress={() => navigation.navigate("Leaderboard", { segmentId: selected.id, segmentName: selected.name })}
              style={styles.cardButton}
            />
          </View>
        </View>
      )}

      {pickingRacer && !selectedUser && (
        <View style={[styles.card, { bottom: hudBottom }]}>
          <Pressable style={styles.cardClose} onPress={() => setPickingRacer(false)} hitSlop={8}>
            <Text style={styles.cardCloseText}>x</Text>
          </Pressable>
          <Text style={styles.cardTitle}>Racers nearby</Text>
          {otherUsers.map((u) => (
            <Pressable
              key={u.deviceId}
              style={styles.racerRow}
              onPress={() => {
                setPickingRacer(false);
                setSelectedUser(u);
              }}
            >
              <Text style={styles.racerRowName} numberOfLines={1}>
                {u.displayName}
              </Text>
              <Text style={styles.racerRowGo}>{">"}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {selectedUser && (
        <View style={[styles.card, { bottom: hudBottom }]}>
          <Pressable
            style={styles.cardClose}
            onPress={() => {
              setSelectedUser(null);
              setRaceStep("closed");
              setRaceError(null);
            }}
            hitSlop={8}
          >
            <Text style={styles.cardCloseText}>x</Text>
          </Pressable>
          <Text style={styles.cardTitle}>{selectedUser.displayName}</Text>

          {raceStep === "closed" && (
            <>
              {raceError && <Text style={styles.raceErrorText}>{raceError}</Text>}
              <Text style={styles.cardMeta}>
                {busy ? "Nearby right now -- finish what you're doing first to race them" : "Nearby right now"}
              </Text>
              <View style={styles.cardActions}>
                {!busy && (
                  <NeonButton
                    label="RACE"
                    onPress={() => {
                      setRaceError(null);
                      setRaceStep("distance");
                    }}
                    style={styles.cardButton}
                  />
                )}
                <NeonButton
                  label={blocking ? "BLOCKING..." : "BLOCK"}
                  variant="outline"
                  onPress={onBlockSelected}
                  disabled={blocking}
                  style={styles.cardButton}
                />
              </View>
            </>
          )}

          {raceStep === "distance" && (
            <>
              <Text style={styles.cardMeta}>Pick a distance to race {selectedUser.displayName}</Text>
              <View style={styles.distanceRow}>
                {RACE_DISTANCES.map((d) => (
                  <Pressable
                    key={d.key}
                    style={styles.distanceOption}
                    onPress={() => handleSelectDistance(d.key)}
                    disabled={creatingChallenge}
                  >
                    <Text style={styles.distanceOptionText}>{d.label}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {raceStep === "direction" && (
            <>
              <Text style={styles.cardMeta}>
                Which way are you racing? Only distance covered that way counts, so pick the direction
                the road actually goes.
              </Text>
              <View style={styles.distanceRow}>
                {RACE_DIRECTIONS.map((d) => (
                  <Pressable
                    key={d.key}
                    style={styles.distanceOption}
                    onPress={() => handleSelectDirection(d.key)}
                    disabled={creatingChallenge}
                  >
                    <Text style={styles.distanceOptionText}>{d.short}</Text>
                  </Pressable>
                ))}
              </View>
              {creatingChallenge && <ActivityIndicator color={colors.cyan} style={{ marginTop: 10 }} />}
            </>
          )}

          {raceStep === "waiting" && (
            <>
              <Text style={styles.cardMeta}>
                Race request sent{pendingDistanceLabel ? ` (${pendingDistanceLabel})` : ""} -- waiting for{" "}
                {selectedUser.displayName}...
              </Text>
              <ActivityIndicator color={colors.cyan} style={{ marginTop: 10, marginBottom: 10 }} />
              <NeonButton label="CANCEL" variant="outline" onPress={cancelOutgoingRace} style={styles.cardButton} />
            </>
          )}
        </View>
      )}

      {/* Not while you're already recording or racing something else --
          accepting would start a second drive on top of the first. */}
      {incomingRace && !busy && (
        <View style={[styles.incomingCard, { top: insets.top + 104 }]}>
          <Text style={styles.cardTitle}>Race request!</Text>
          <Text style={styles.cardMeta}>
            {incomingRace.opponentDisplayName} wants to race you -- {incomingRace.distanceLabel}{" "}
            {incomingRace.directionLabel}
          </Text>
          <View style={styles.cardActions}>
            <NeonButton
              label="ACCEPT"
              onPress={() => respondIncoming(true)}
              disabled={respondingIncoming}
              style={styles.cardButton}
            />
            <NeonButton
              label="DECLINE"
              variant="outline"
              onPress={() => respondIncoming(false)}
              disabled={respondingIncoming}
              style={styles.cardButton}
            />
          </View>
        </View>
      )}

      {busy ? (
        <NeonButton
          label={busy.kind === "race" ? "BACK TO THE RACE" : "BACK TO RECORDING"}
          onPress={() => navigation.goBack()}
          style={[styles.fabWide, { bottom: bottomBase }]}
        />
      ) : (
        <>
          <NeonButton
            label="+ NEW SEGMENT"
            variant="outline"
            onPress={() => navigation.navigate("CreateSegment")}
            style={[styles.fab, { bottom: bottomBase }]}
          />
          <NeonButton
            label="GO TO..."
            onPress={() => navigation.navigate("GoTo")}
            style={[styles.fabRight, { bottom: bottomBase }]}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { alignItems: "center", justifyContent: "center" },
  topBar: {
    position: "absolute",
    left: 16,
    right: 16,
    gap: 8,
  },
  accountPill: {
    ...panelStyle,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    paddingHorizontal: 12,
    gap: 10,
  },
  accountLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  topBarName: { flex: 1, color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 13 },
  accountChevron: { color: colors.cyan, fontSize: 14, fontWeight: "800" },
  topBarRow: { flexDirection: "row", gap: 8 },
  topBarButton: {
    flex: 1,
    ...panelStyle,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  topBarButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  locationBanner: {
    backgroundColor: "#2a1a0aee",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.racePrimary,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  locationBannerText: { flex: 1, color: colors.textPrimary, fontSize: 12, fontWeight: "600" },
  locationBannerAction: { color: colors.racePrimary, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  errorBox: {
    backgroundColor: "#2a1414ee",
    borderRadius: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 12, fontWeight: "600" },
  errorRetry: { color: colors.textPrimary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, marginTop: 6 },
  trackLabel: {
    backgroundColor: "#000000dd",
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1.5,
    borderColor: colors.cyan,
    maxWidth: 150,
  },
  trackLabelSelected: {
    backgroundColor: colors.racePrimary,
    borderColor: colors.racePrimary,
  },
  trackLabelText: { color: colors.textPrimary, fontSize: 11, fontWeight: "700" },
  recenterButton: {
    position: "absolute",
    right: 16,
    bottom: 170,
    width: 44,
    height: 44,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  tracksToggle: { width: 44, height: 44, borderColor: colors.cyan },
  tracksToggleOff: { borderColor: colors.panelBorder, opacity: 0.8 },
  tracksToggleText: { color: colors.cyan, fontSize: 8, fontWeight: "800", textAlign: "center", letterSpacing: 0.3 },
  tracksToggleTextOff: { color: colors.textMuted },
  recenterIcon: { color: colors.cyan, fontSize: 18, fontWeight: "800" },
  speedHud: {
    position: "absolute",
    left: 16,
    bottom: 100,
    ...panelStyle,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: "center",
    minWidth: 110,
    maxWidth: 170,
  },
  speedValue: { color: colors.cyan, fontFamily: fonts.display, fontSize: 32, lineHeight: 38 },
  speedUnit: { color: colors.textSecondary, fontSize: 11, marginBottom: 4, letterSpacing: 1 },
  nearbyCount: { color: colors.textSecondary, fontSize: 11, marginTop: 4, textAlign: "center" },
  onlineCount: { color: colors.racePrimary, fontSize: 11, marginTop: 2, textAlign: "center", fontWeight: "700" },
  voiceCount: { color: colors.cyan, fontSize: 11, marginTop: 2, textAlign: "center", fontWeight: "700", maxWidth: 140 },
  talkButton: {
    position: "absolute",
    right: 16,
    width: 148,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.panel,
    borderWidth: 1.5,
    borderColor: colors.cyan,
    alignItems: "center",
    justifyContent: "center",
  },
  talkButtonActive: { backgroundColor: colors.racePrimary, borderColor: colors.racePrimary },
  talkButtonDisabled: { opacity: 0.7, borderStyle: "dashed" },
  talkButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  talkButtonTextActive: { color: colors.bg },
  otherUserWrap: { alignItems: "center" },
  otherUserLabel: {
    backgroundColor: "#000000dd",
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: colors.racePrimary,
    maxWidth: 110,
    marginTop: 2,
  },
  otherUserLabelText: { color: colors.textPrimary, fontSize: 10, fontWeight: "700" },
  card: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 100,
    ...panelStyle,
    padding: 16,
  },
  cardClose: { position: "absolute", top: 10, right: 12, padding: 4 },
  cardCloseText: { color: colors.textSecondary, fontSize: 16, fontWeight: "700" },
  cardTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 16, marginBottom: 6, paddingRight: 24 },
  cardMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  cardActions: { flexDirection: "row", marginTop: 14, gap: 10 },
  cardButton: { flex: 1 },
  racerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  racerRowName: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  racerRowGo: { color: colors.cyan, fontSize: 15, fontWeight: "800" },
  raceErrorText: { color: colors.danger, fontSize: 12, marginBottom: 6, fontWeight: "600" },
  distanceRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  distanceOption: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.cyan,
    borderRadius: 6,
    paddingVertical: 12,
    alignItems: "center",
  },
  distanceOptionText: { color: colors.cyan, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  incomingCard: {
    position: "absolute",
    left: 16,
    right: 16,
    ...panelStyle,
    padding: 16,
    borderColor: colors.racePrimary,
  },
  fab: {
    position: "absolute",
    bottom: 24,
    left: 20,
    width: "44%",
  },
  fabRight: {
    position: "absolute",
    bottom: 24,
    right: 20,
    width: "44%",
  },
  // Takes the place of both FABs while something is recording underneath.
  fabWide: {
    position: "absolute",
    bottom: 24,
    left: 20,
    right: 20,
  },
  busyBanner: {
    backgroundColor: "#0a2430ee",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.cyan,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  busyBannerTextWrap: { flex: 1 },
  busyBannerTitle: { color: colors.textPrimary, fontSize: 12, fontWeight: "700" },
  busyBannerSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  busyBannerAction: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
});
