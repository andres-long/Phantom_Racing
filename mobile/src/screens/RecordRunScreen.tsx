import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary, GhostProfileResponse, LatLng, PresenceUser } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import {
  cumulativeDistances,
  projectOntoPolyline,
  ghostElapsedAtDistance,
  distanceAtElapsed,
  pointAtDistance,
  formatDuration,
} from "../utils/geo";
import { displaySpeedKmh, speedUnit } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
import NeonButton from "../components/NeonButton";
import VehicleMarker from "../components/VehicleMarker";
import {
  BackgroundLocationPoint,
  requestBackgroundLocationPermission,
  setBackgroundLocationListener,
  startBackgroundTracking,
  stopBackgroundTracking,
} from "../backgroundLocation";
import { usePresenceHeartbeat, PresencePositionRef } from "../hooks/usePresenceHeartbeat";
import { useNearbyRacers } from "../hooks/useNearbyRacers";
import { useIncomingRace } from "../hooks/useIncomingRace";
import { RacerMarkers, IncomingRaceCard } from "../components/RacersOnTheRoad";
import { useStaleSpeedReset } from "../utils/speed";
import { recordSpeed, flushTopSpeed } from "../topSpeed";

type Props = NativeStackScreenProps<RootStackParamList, "RecordRun">;
type TracePoint = LatLng & { t: number };

export default function RecordRunScreen({ route, navigation }: Props) {
  const { segmentId, autoStart } = route.params;
  const { user, vehicleStyle, units } = useUser();
  const insets = useSafeAreaInsets();

  const [segment, setSegment] = useState<SegmentSummary | null>(null);
  const [ghost, setGhost] = useState<GhostProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [recording, setRecording] = useState(false);
  const [trace, setTrace] = useState<TracePoint[]>([]);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [deltaMs, setDeltaMs] = useState<number | null>(null);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const mapRef = useRef<MapView | null>(null);
  const cumDistRef = useRef<number[]>([]);
  const startTimeRef = useRef<number>(0);
  const finishedRef = useRef(false);
  const maxSpeedRef = useRef(0);
  const autoStartTriggeredRef = useRef(false);
  // Keeps this device visible on other users' maps while racing -- see
  // usePresenceHeartbeat. Updated inline in handleLocationPoints below
  // rather than via a separate effect, so it stays current without adding
  // another render/effect on every GPS point.
  const presencePosRef: PresencePositionRef = useRef(null);
  usePresenceHeartbeat(presencePosRef);

  // Other racers stay on the map while you drive, and you can race them --
  // either direction. A race started from here runs on top of this screen;
  // this recording keeps going underneath (see backgroundLocation.ts).
  // Only while this screen is the one on show -- a race or the map pushed
  // on top has its own.
  const isFocused = useIsFocused();
  const nearbyRacers = useNearbyRacers(presencePosRef, recording && isFocused);
  const { incoming, responding, respond } = useIncomingRace(recording && isFocused);
  // Speed readout back to 0 once fixes stop arriving -- they only come when
  // you've moved a few metres, so stopping used to freeze the last speed.
  const markFix = useStaleSpeedReset(() => setSpeedKmh(0));

  const challengeRacer = (racer: PresenceUser) => {
    Alert.alert(`Race ${racer.displayName}?`, "Your recording keeps going while you race.", [
      { text: "Not now", style: "cancel" },
      {
        text: "Race",
        onPress: () => navigation.push("Home", { busy: { kind: "run" as const, label: `Timing your run on ${segment?.name ?? "this track"}` }, challenge: racer.deviceId }),
      },
    ]);
  };

  const acceptIncoming = async () => {
    const race = await respond(true, presencePosRef.current?.coords ?? null);
    if (race) navigation.push("RaceLive", { raceId: race.id });
  };

  useEffect(() => {
    (async () => {
      try {
        // deviceId included so a private track's own creator can still race
        // it -- see canAccessSegment on the backend.
        const seg = await api.getSegment(segmentId, user?.deviceId);
        setSegment(seg);
        cumDistRef.current = cumulativeDistances(seg.points);
        try {
          const g = await api.getGhost(segmentId, undefined, user?.deviceId);
          setGhost(g);
        } catch {
          // No runs yet on this segment -- fine, you'll just be setting the
          // first time with no ghost to chase.
        }
      } catch (e: any) {
        Alert.alert("Couldn't load segment", e.message || "Unknown error");
        navigation.goBack();
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      stopBackgroundTracking("run");
    };
  }, [segmentId]);

  // A one-off fix so the vehicle marker has somewhere to sit before you tap
  // "Start run" -- the live watcher below only runs once recording begins.
  // Best-effort: if permission isn't granted yet, startRun's own check
  // handles that when you actually try to race.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setMyPos({ lat: loc.coords.latitude, lng: loc.coords.longitude });
        if (loc.coords.heading != null && loc.coords.heading >= 0) {
          setHeading(loc.coords.heading);
        }
      } catch {
        // No initial fix available -- the marker just won't show until
        // recording starts, which is fine.
      }
    })();
  }, []);

  const finishRun = async (finalTrace: TracePoint[]) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    await stopBackgroundTracking("run");
    setRecording(false);

    if (!user || !segment) {
      Alert.alert("Not connected", "Lost connection to the server -- your run wasn't submitted.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.submitRun(segmentId, user.deviceId, finalTrace, maxSpeedRef.current);
      navigation.replace("RunSummary", { result, segmentName: segment.name, segmentId });
    } catch (e: any) {
      Alert.alert("Run not counted", e.message || "Unknown error", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  // Fed by the background-capable location task (see ../backgroundLocation)
  // instead of a plain watchPositionAsync subscription, so recording keeps
  // going if you lock the phone or switch apps mid-run. A batch can contain
  // more than one point (e.g. after a brief background gap); every point
  // goes into the trace for accurate timing/leaderboard math, while the
  // marker/HUD just reflect the most recent one.
  const handleLocationPoints = (points: BackgroundLocationPoint[]) => {
    if (!segment || points.length === 0) return;
    const newPoints: TracePoint[] = points.map((p) => ({ lat: p.lat, lng: p.lng, t: p.t }));
    const last = points[points.length - 1];

    setMyPos({ lat: last.lat, lng: last.lng });
    if (last.heading != null) setHeading(last.heading);
    presencePosRef.current = { coords: { lat: last.lat, lng: last.lng }, heading: last.heading ?? null };
    // Tighter than the old 0.015 so turns on small roads/blocks are easier
    // to spot coming up, rather than getting lost in a wide zoomed-out view.
    mapRef.current?.animateToRegion(
      { latitude: last.lat, longitude: last.lng, latitudeDelta: 0.006, longitudeDelta: 0.006 },
      500
    );
    setSpeedKmh(last.speedKmh);
    markFix();
    recordSpeed(last.speedKmh);
    if (last.speedKmh > maxSpeedRef.current) {
      maxSpeedRef.current = last.speedKmh;
      setMaxSpeedKmh(last.speedKmh);
    }

    setTrace((prev) => {
      const next = [...prev, ...newPoints];

      const cumDist = cumDistRef.current;
      const totalLength = cumDist[cumDist.length - 1] ?? 0;
      const lastPoint = newPoints[newPoints.length - 1];
      const { distanceAlongM } = projectOntoPolyline(segment.points, cumDist, lastPoint);
      const elapsed = lastPoint.t - startTimeRef.current;
      setElapsedMs(elapsed);
      setProgress(totalLength > 0 ? Math.min(1, distanceAlongM / totalLength) : 0);

      if (ghost) {
        const ghostElapsed = ghostElapsedAtDistance(ghost.profile, distanceAlongM);
        if (ghostElapsed != null) setDeltaMs(ghostElapsed - elapsed);
      }

      // Auto-finish once we're essentially at the end of the segment.
      if (totalLength > 0 && distanceAlongM >= totalLength * 0.98 && elapsed >= 3000 && next.length >= 3) {
        finishRun(next);
      }
      return next;
    });
  };

  const startRun = async () => {
    if (!segment) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Location permission needed", "Can't time a run without location access.");
      return;
    }
    const bgGranted = await requestBackgroundLocationPermission();
    if (!bgGranted) {
      Alert.alert(
        "Background location not granted",
        'Recording will pause if you lock your phone or leave the app mid-run. For uninterrupted recording, allow location access "All the time" in Settings.'
      );
    }

    finishedRef.current = false;
    setTrace([]);
    maxSpeedRef.current = 0;
    setMaxSpeedKmh(0);
    startTimeRef.current = Date.now();
    setRecording(true);

    setBackgroundLocationListener(handleLocationPoints, "run");
    await startBackgroundTracking(`Timing your run on ${segment.name}. Tap to return to Phantom Racing.`, "run");
  };

  // Auto-detected races (jumped here straight from the map because you were
  // clearly driving right at a track's start) begin timing immediately --
  // no need to also tap "Start run". Guarded to fire once, right after the
  // segment finishes loading.
  useEffect(() => {
    if (!loading && segment && autoStart && !autoStartTriggeredRef.current) {
      autoStartTriggeredRef.current = true;
      startRun();
    }
  }, [loading, segment]);

  const stopRun = () => finishRun(trace);

  // The map/menu opens *on top of* this screen rather than replacing it, so
  // the run keeps being timed and recorded the whole time you're over there
  // -- Home shows a banner, and coming back lands you right here.
  const openMenu = () => {
    flushTopSpeed();
    navigation.push("Home", {
      busy: { kind: "run", label: `Timing your run on ${segment?.name ?? "this track"}` },
    });
  };

  const onCancel = () => {
    if (recording) {
      Alert.alert("Leave this run?", "You can take a look at the map without ending it.", [
        { text: "Keep racing", style: "cancel" },
        { text: "Map (keep timing)", onPress: openMenu },
        {
          text: "Cancel run",
          style: "destructive",
          onPress: () => {
            finishedRef.current = true;
            stopBackgroundTracking("run");
            navigation.goBack();
          },
        },
      ]);
    } else {
      navigation.goBack();
    }
  };

  if (loading || !segment) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.cyan} />
      </View>
    );
  }

  const ghostMarker =
    recording && ghost
      ? pointAtDistance(segment.points, cumDistRef.current, distanceAtElapsed(ghost.profile, elapsedMs))
      : null;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={{
          latitude: segment.points[0].lat,
          longitude: segment.points[0].lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        <Polyline
          coordinates={segment.points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
          strokeColor={colors.cyan}
          strokeWidth={4}
        />
        {myPos && (
          <Marker
            coordinate={{ latitude: myPos.lat, longitude: myPos.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={heading}
            flat
            tracksViewChanges={false}
          >
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
        {ghostMarker && (
          <Marker
            coordinate={{ latitude: ghostMarker.lat, longitude: ghostMarker.lng }}
            title={ghost?.displayName ?? "Ghost"}
            pinColor={colors.gold}
          />
        )}
        <RacerMarkers racers={nearbyRacers} onSelect={challengeRacer} />
      </MapView>

      <Pressable style={[styles.cancelButton, { top: insets.top + 10 }]} onPress={onCancel} hitSlop={10}>
        <Text style={styles.cancelText}>x</Text>
      </Pressable>

      {recording && (
        <Pressable style={[styles.menuButton, { top: insets.top + 10 }]} onPress={openMenu} hitSlop={10}>
          <Text style={styles.menuButtonText}>MAP</Text>
        </Pressable>
      )}

      {/* Starts below the x / MAP row rather than covering it. */}
      <View style={[styles.hud, { top: insets.top + 56 }]}>
        <Text style={styles.segmentName}>{segment.name}</Text>
        {autoStart && <Text style={styles.autoBadge}>AUTO-DETECTED -- RACING STARTED AUTOMATICALLY</Text>}
        <Text style={styles.time}>{formatDuration(elapsedMs)}</Text>
        {ghost ? (
          deltaMs != null && (
            <Text style={[styles.delta, { color: deltaMs >= 0 ? colors.cyan : colors.racePrimary }]}>
              {deltaMs >= 0 ? "AHEAD" : "BEHIND"} by {formatDuration(Math.abs(deltaMs))}
            </Text>
          )
        ) : (
          <Text style={styles.noGhost}>No ghost yet -- you're setting the first time</Text>
        )}
        <Text style={styles.speed}>
          {displaySpeedKmh(speedKmh, units)} {speedUnit(units)}{"   "}
          <Text style={styles.topSpeed}>top {displaySpeedKmh(maxSpeedKmh, units)}</Text>
        </Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
      </View>

      <NeonButton
        label={submitting ? "SUBMITTING..." : recording ? "FINISH RUN" : "START RUN"}
        onPress={recording ? stopRun : startRun}
        disabled={submitting}
        variant={recording ? "outline" : "primary"}
        style={styles.button}
      />

      {incoming && (
        <IncomingRaceCard
          race={incoming}
          busy={responding}
          onAccept={acceptIncoming}
          onDecline={() => respond(false, null)}
          style={{ bottom: 110 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  cancelButton: {
    position: "absolute",
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: colors.cyan, fontSize: 16, fontWeight: "800" },
  // Sits beside the x: takes you to the map without ending anything.
  menuButton: {
    position: "absolute",
    left: 60,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  hud: {
    position: "absolute",
    left: 20,
    right: 20,
    ...panelStyle,
    padding: 16,
  },
  segmentName: { color: colors.textSecondary, fontSize: 13, textAlign: "center", marginBottom: 4 },
  autoBadge: { color: colors.cyan, fontSize: 10, fontWeight: "700", textAlign: "center", marginBottom: 4, letterSpacing: 0.5 },
  time: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 38, textAlign: "center" },
  delta: { fontFamily: fonts.heading, fontSize: 15, textAlign: "center", marginTop: 6 },
  noGhost: { color: colors.textSecondary, fontSize: 13, textAlign: "center", marginTop: 4 },
  speed: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: 8 },
  topSpeed: { color: colors.textMuted, fontSize: 12 },
  progressTrack: { height: 6, backgroundColor: colors.bgElevated, borderRadius: 3, marginTop: 12, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: colors.cyan },
  button: {
    position: "absolute",
    bottom: 30,
    left: 20,
    right: 20,
  },
});
