import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary, GhostProfileResponse, LatLng } from "../types";
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
import { colors, fonts, panelStyle } from "../theme";
import NeonButton from "../components/NeonButton";

type Props = NativeStackScreenProps<RootStackParamList, "RecordRun">;
type TracePoint = LatLng & { t: number };

export default function RecordRunScreen({ route, navigation }: Props) {
  const { segmentId, autoStart } = route.params;
  const { user } = useUser();

  const [segment, setSegment] = useState<SegmentSummary | null>(null);
  const [ghost, setGhost] = useState<GhostProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [recording, setRecording] = useState(false);
  const [trace, setTrace] = useState<TracePoint[]>([]);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [deltaMs, setDeltaMs] = useState<number | null>(null);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const mapRef = useRef<MapView | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const cumDistRef = useRef<number[]>([]);
  const startTimeRef = useRef<number>(0);
  const finishedRef = useRef(false);
  const maxSpeedRef = useRef(0);
  const autoStartTriggeredRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const seg = await api.getSegment(segmentId);
        setSegment(seg);
        cumDistRef.current = cumulativeDistances(seg.points);
        try {
          const g = await api.getGhost(segmentId);
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
      subscriptionRef.current?.remove();
    };
  }, [segmentId]);

  const finishRun = async (finalTrace: TracePoint[]) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
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

  const startRun = async () => {
    if (!segment) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Location permission needed", "Can't time a run without location access.");
      return;
    }

    finishedRef.current = false;
    setTrace([]);
    maxSpeedRef.current = 0;
    setMaxSpeedKmh(0);
    startTimeRef.current = Date.now();
    setRecording(true);

    subscriptionRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 500, distanceInterval: 3 },
      (loc) => {
        const point: TracePoint = {
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          t: Date.now(),
        };
        setMyPos(point);
        // This watcher only runs while a run is actively being recorded (it's
        // created in startRun and torn down in finishRun), so it's safe to
        // just always keep the map centered on you here -- no separate
        // "recording" check needed. Without this the map stayed frozen on
        // wherever it opened, and your position marker drove itself off
        // screen within a few seconds.
        mapRef.current?.animateToRegion(
          { latitude: point.lat, longitude: point.lng, latitudeDelta: 0.015, longitudeDelta: 0.015 },
          500
        );
        const currentSpeedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
        setSpeedKmh(currentSpeedKmh);
        if (currentSpeedKmh > maxSpeedRef.current) {
          maxSpeedRef.current = currentSpeedKmh;
          setMaxSpeedKmh(currentSpeedKmh);
        }

        setTrace((prev) => {
          const next = [...prev, point];

          const cumDist = cumDistRef.current;
          const totalLength = cumDist[cumDist.length - 1] ?? 0;
          const { distanceAlongM } = projectOntoPolyline(segment.points, cumDist, point);
          const elapsed = point.t - startTimeRef.current;
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
      }
    );
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

  const onCancel = () => {
    if (recording) {
      Alert.alert("Cancel this run?", "Your progress won't be saved.", [
        { text: "Keep racing", style: "cancel" },
        {
          text: "Cancel run",
          style: "destructive",
          onPress: () => {
            finishedRef.current = true;
            subscriptionRef.current?.remove();
            subscriptionRef.current = null;
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
        showsUserLocation
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
        {ghostMarker && (
          <Marker
            coordinate={{ latitude: ghostMarker.lat, longitude: ghostMarker.lng }}
            title={ghost?.displayName ?? "Ghost"}
            pinColor={colors.gold}
          />
        )}
      </MapView>

      <Pressable style={styles.cancelButton} onPress={onCancel} hitSlop={10}>
        <Text style={styles.cancelText}>x</Text>
      </Pressable>

      <View style={styles.hud}>
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
          {Math.round(speedKmh)} km/h{"   "}
          <Text style={styles.topSpeed}>top {Math.round(maxSpeedKmh)}</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  cancelButton: {
    position: "absolute",
    top: 50,
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
  hud: {
    position: "absolute",
    top: 60,
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
