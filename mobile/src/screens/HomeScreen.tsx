import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, AppState } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, Region } from "react-native-maps";
import * as Location from "expo-location";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary, LatLng, PresenceUser, MapBounds } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { cumulativeDistances, projectOntoPolyline, pointAtDistance, haversine } from "../utils/geo";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
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
export default function HomeScreen({ navigation }: Props) {
  const { user, vehicleStyle, incognito } = useUser();
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
  const userRef = useRef(user);
  const regionRef = useRef<Region>(FALLBACK_REGION);
  const presenceInFlightRef = useRef(false);

  useEffect(() => {
    incognitoRef.current = incognito;
  }, [incognito]);
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
    if (!deviceId || !pos || AppState.currentState !== "active") return;
    api.sendHeartbeat(deviceId, pos.coords, pos.heading, incognitoRef.current).catch(() => {});
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

  const loadSegments = useCallback(async () => {
    try {
      setError(null);
      const data = await api.listSegments();
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
      loadSegments();
      let cancelled = false;
      let autoStarted = false;

      (async () => {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted" || cancelled) return;
        subscriptionRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 5 },
          (loc) => {
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
            const currentSpeedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
            setSpeedKmh(currentSpeedKmh);

            if (followRef.current) {
              mapRef.current?.animateToRegion(
                { latitude: pos.lat, longitude: pos.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 },
                500
              );
            }

            // Guarded to fire at most once per visit to this screen, so it
            // can't re-trigger every second while sitting still right at a
            // start line -- only an actual approach at driving speed counts.
            if (!autoStarted && currentSpeedKmh >= AUTO_START_SPEED_KMH) {
              const candidate = nearbyRef.current.find(
                (s) => s.points.length >= 2 && haversine(pos, s.points[0]) <= AUTO_START_RADIUS_M
              );
              if (candidate) {
                autoStarted = true;
                navigation.navigate("RecordRun", { segmentId: candidate.id, autoStart: true });
              }
            }
          }
        );
      })();

      // Presence: one immediate tick so markers/your own visibility don't
      // wait a full interval on first focus, then every HEARTBEAT_INTERVAL_MS
      // for as long as this screen stays focused.
      sendHeartbeatTick();
      refreshPresence();
      const presenceTimer = setInterval(() => {
        sendHeartbeatTick();
        refreshPresence();
      }, HEARTBEAT_INTERVAL_MS);

      return () => {
        cancelled = true;
        subscriptionRef.current?.remove();
        subscriptionRef.current = null;
        clearInterval(presenceTimer);
      };
    }, [loadSegments, navigation, sendHeartbeatTick, refreshPresence])
  );

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
      { latitude: userPos.lat, longitude: userPos.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 },
      400
    );
  };

  const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)}m away` : `${(m / 1000).toFixed(1)}km away`);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={FALLBACK_REGION}
        onPress={() => setSelectedId(null)}
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
            coordinate={{ latitude: userPos.lat, longitude: userPos.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={heading}
            flat
            tracksViewChanges={false}
          >
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
        {otherUsers.map((u) => (
          <Marker
            key={u.deviceId}
            coordinate={{ latitude: u.lat, longitude: u.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={u.heading ?? 0}
            flat={u.heading != null}
            tracksViewChanges={false}
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
        {nearby.map((s) => {
          const cumDist = cumulativeDistances(s.points);
          const mid = pointAtDistance(s.points, cumDist, cumDist[cumDist.length - 1] / 2);
          const isSelected = s.id === selectedId;
          return (
            <React.Fragment key={s.id}>
              <Polyline
                coordinates={s.points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
                strokeColor={isSelected ? colors.racePrimary : colors.cyan}
                strokeWidth={isSelected ? 6 : 4}
                tappable
                onPress={() => setSelectedId(s.id)}
              />
              <Marker
                coordinate={{ latitude: mid.lat, longitude: mid.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                onPress={() => setSelectedId(s.id)}
              >
                <View style={[styles.trackLabel, isSelected && styles.trackLabelSelected]}>
                  <Text style={styles.trackLabelText} numberOfLines={1}>
                    {s.name}
                  </Text>
                </View>
              </Marker>
            </React.Fragment>
          );
        })}
      </MapView>

      <View style={[styles.topBar, { top: insets.top + 10 }]}>
        <Pressable onPress={() => navigation.navigate("Username")} hitSlop={8} style={styles.topBarLeft}>
          <Text style={styles.topBarName} numberOfLines={1}>
            {user ? `${user.displayName} >` : "Connecting..."}
          </Text>
        </Pressable>
        <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("AllSegments")}>
          <Text style={styles.topBarButtonText}>ALL TRACKS</Text>
        </Pressable>
        <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("Welcome")}>
          <Text style={styles.topBarButtonText}>HOW IT WORKS</Text>
        </Pressable>
      </View>

      {error && (
        <View style={[styles.errorBox, { top: insets.top + 56 }]}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Pressable style={styles.recenterButton} onPress={recenter}>
        <Text style={styles.recenterIcon}>o</Text>
      </Pressable>

      <View style={styles.speedHud}>
        {loading ? (
          <ActivityIndicator color={colors.cyan} />
        ) : (
          <>
            <Text style={styles.speedValue}>{Math.round(speedKmh)}</Text>
            <Text style={styles.speedUnit}>km/h</Text>
          </>
        )}
        <Text style={styles.nearbyCount}>
          {nearby.length === 0
            ? "No tracks nearby yet"
            : `${nearby.length} track${nearby.length === 1 ? "" : "s"} nearby`}
        </Text>
        {otherUsers.length > 0 && (
          <Text style={styles.onlineCount}>
            {otherUsers.length} racer{otherUsers.length === 1 ? "" : "s"} on the map
          </Text>
        )}
      </View>

      {selected && (
        <View style={styles.card}>
          <Pressable style={styles.cardClose} onPress={() => setSelectedId(null)} hitSlop={8}>
            <Text style={styles.cardCloseText}>x</Text>
          </Pressable>
          <Text style={styles.cardTitle}>{selected.name}</Text>
          <Text style={styles.cardMeta}>
            {formatDistance(selected.distanceM)} -- {(selected.lengthM / 1000).toFixed(2)} km
          </Text>
          <Text style={styles.cardMeta}>
            {selected.bestTimeMs != null
              ? `Best ${(selected.bestTimeMs / 1000).toFixed(1)}s by ${selected.bestTimeUser}`
              : "No runs yet -- be the first"}
          </Text>
          <View style={styles.cardActions}>
            <NeonButton
              label="RACE IT"
              onPress={() => navigation.navigate("RecordRun", { segmentId: selected.id })}
              style={styles.cardButton}
            />
            <NeonButton
              label="LEADERBOARD"
              variant="outline"
              onPress={() => navigation.navigate("Leaderboard", { segmentId: selected.id, segmentName: selected.name })}
              style={styles.cardButton}
            />
          </View>
        </View>
      )}

      <NeonButton
        label="+ NEW SEGMENT"
        variant="outline"
        onPress={() => navigation.navigate("CreateSegment")}
        style={styles.fab}
      />
      <NeonButton label="GO TO..." onPress={() => navigation.navigate("GoTo")} style={styles.fabRight} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  topBarLeft: {
    flex: 1,
    ...panelStyle,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  topBarName: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 12 },
  topBarButton: {
    ...panelStyle,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  topBarButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  errorBox: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: "#2a1414ee",
    borderRadius: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 12, fontWeight: "600" },
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
  },
  speedValue: { color: colors.cyan, fontFamily: fonts.display, fontSize: 32, lineHeight: 38 },
  speedUnit: { color: colors.textSecondary, fontSize: 11, marginBottom: 4, letterSpacing: 1 },
  nearbyCount: { color: colors.textSecondary, fontSize: 11, marginTop: 4, textAlign: "center" },
  onlineCount: { color: colors.racePrimary, fontSize: 11, marginTop: 2, textAlign: "center", fontWeight: "700" },
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
});
