import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { cumulativeDistances, projectOntoPolyline, haversine, formatDuration } from "../utils/geo";
import { displaySpeedKmh, speedUnit, formatDistanceShort } from "../utils/units";
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
import { recordSpeed, flushTopSpeed } from "../topSpeed";

type Props = NativeStackScreenProps<RootStackParamList, "GoRace">;
type TracePoint = LatLng & { t: number };

// How far off the planned route (meters) counts as "you took a different
// turn" rather than GPS jitter. Two consecutive samples past this before a
// reroute fires, so a single noisy reading near an overpass/underpass can't
// trigger one on its own.
const DEVIATION_THRESHOLD_M = 70;
const DEVIATION_STREAK_TO_REROUTE = 2;
const REROUTE_COOLDOWN_MS = 20000;

// How close to the destination coordinate counts as "arrived" -- tighter
// than a segment's start/end tolerance since this is a single point (a
// business, an address), not the end of a hand-recorded polyline.
const ARRIVAL_RADIUS_M = 40;

// The live, tracked drive to a searched destination: draws the planned
// route, follows you with the same vehicle marker as everywhere else, and
// re-fetches the route the moment you stray from it (a wrong turn, a
// closed road, whatever) so the line on screen always matches where you're
// actually headed. Recording starts the moment this screen mounts -- by the
// time you're here you already tapped START on GoToScreen's preview.
export default function GoRaceScreen({ route, navigation }: Props) {
  const { destinationName, destination, route: initialRoute, distanceM: initialDistanceM, durationS } =
    route.params;
  const { user, vehicleStyle, units } = useUser();
  const insets = useSafeAreaInsets();

  const [plannedRoute, setPlannedRoute] = useState<LatLng[]>(initialRoute);
  const [rerouting, setRerouting] = useState(false);
  const [trace, setTrace] = useState<TracePoint[]>([]);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [distanceRemainingM, setDistanceRemainingM] = useState(initialDistanceM);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const mapRef = useRef<MapView | null>(null);
  // The background-location listener is registered once (empty-deps mount
  // effect below) so its closure would otherwise keep seeing the route from
  // that first render forever, even after a reroute swaps `plannedRoute` --
  // it reads this ref instead, which the effect below keeps current.
  const plannedRouteRef = useRef<LatLng[]>(initialRoute);
  const cumDistRef = useRef<number[]>(cumulativeDistances(initialRoute));
  const startTimeRef = useRef<number>(Date.now());
  const finishedRef = useRef(false);
  const maxSpeedRef = useRef(0);
  const deviationStreakRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const reroutingRef = useRef(false);
  // Keeps this device visible on other users' maps while driving -- see
  // usePresenceHeartbeat.
  const presencePosRef: PresencePositionRef = useRef(null);
  usePresenceHeartbeat(presencePosRef);

  useEffect(() => {
    plannedRouteRef.current = plannedRoute;
    cumDistRef.current = cumulativeDistances(plannedRoute);
  }, [plannedRoute]);

  const finishTrip = async (finalTrace: TracePoint[]) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    await stopBackgroundTracking();

    if (!user) {
      Alert.alert("Not connected", "Lost connection to the server -- your trip wasn't saved.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.submitTrip(
        user.deviceId,
        destinationName,
        destination,
        finalTrace,
        maxSpeedRef.current,
        durationS
      );
      navigation.replace("GoSummary", { result });
    } catch (e: any) {
      Alert.alert("Trip not saved", e.message || "Unknown error", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  const reroute = async (from: LatLng) => {
    if (reroutingRef.current) return;
    reroutingRef.current = true;
    setRerouting(true);
    try {
      const fresh = await api.getDirections(from, destination);
      setPlannedRoute(fresh.points);
      setDistanceRemainingM(fresh.distanceM);
      deviationStreakRef.current = 0;
    } catch {
      // Transient network hiccup -- keep driving the old planned route
      // rather than interrupting the trip over it. The next deviation
      // check will just try again.
    } finally {
      reroutingRef.current = false;
      setRerouting(false);
    }
  };

  const handleLocationPoints = (points: BackgroundLocationPoint[]) => {
    if (points.length === 0) return;
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
    recordSpeed(last.speedKmh);
    if (last.speedKmh > maxSpeedRef.current) {
      maxSpeedRef.current = last.speedKmh;
      setMaxSpeedKmh(last.speedKmh);
    }

    const lastPoint = newPoints[newPoints.length - 1];
    const cumDist = cumDistRef.current;
    const totalLength = cumDist[cumDist.length - 1] ?? 0;
    const { distanceAlongM, lateralDistanceM } = projectOntoPolyline(plannedRouteRef.current, cumDist, lastPoint);
    setDistanceRemainingM(Math.max(0, totalLength - distanceAlongM));
    setProgress(totalLength > 0 ? Math.min(1, distanceAlongM / totalLength) : 0);

    if (lateralDistanceM > DEVIATION_THRESHOLD_M) {
      deviationStreakRef.current += 1;
    } else {
      deviationStreakRef.current = 0;
    }
    const now = Date.now();
    if (
      deviationStreakRef.current >= DEVIATION_STREAK_TO_REROUTE &&
      now - lastRerouteAtRef.current > REROUTE_COOLDOWN_MS
    ) {
      lastRerouteAtRef.current = now;
      reroute({ lat: last.lat, lng: last.lng });
    }

    setTrace((prev) => {
      const next = [...prev, ...newPoints];
      const elapsed = lastPoint.t - startTimeRef.current;
      setElapsedMs(elapsed);

      const distToDestM = haversine({ lat: last.lat, lng: last.lng }, destination);
      if (distToDestM <= ARRIVAL_RADIUS_M && elapsed >= 5000 && next.length >= 3) {
        finishTrip(next);
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) {
        Alert.alert("Location permission needed", "Can't track a drive without location access.", [
          { text: "OK", onPress: () => navigation.goBack() },
        ]);
        return;
      }
      const bgGranted = await requestBackgroundLocationPermission();
      if (!bgGranted) {
        Alert.alert(
          "Background location not granted",
          'Tracking will pause if you lock your phone or leave the app mid-drive. For uninterrupted tracking, allow location access "All the time" in Settings.'
        );
      }
      if (cancelled) return;
      startTimeRef.current = Date.now();
      setBackgroundLocationListener(handleLocationPoints);
      await startBackgroundTracking(`Driving to ${destinationName}. Tap to return to Phantom Racing.`);
    })();
    return () => {
      cancelled = true;
      stopBackgroundTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual completion, for when the destination coordinate itself isn't
  // reachable (a gated driveway, a parking lot GPS can't quite resolve, a
  // spot indoors) so the automatic within-40m arrival check in
  // handleLocationPoints never fires on its own.
  const onFinishManually = () => {
    if (trace.length < 2) {
      Alert.alert("Not enough of a drive yet", "Drive a bit more before finishing.");
      return;
    }
    finishTrip(trace);
  };

  // Opens the map/menu on top of this screen instead of replacing it, so
  // the drive keeps being tracked while you look around -- Home shows a
  // banner, and going back drops you straight back into the drive.
  const openMenu = () => {
    flushTopSpeed();
    navigation.push("Home", { busy: { kind: "trip", label: `Driving to ${destinationName}` } });
  };

  const onCancel = () => {
    Alert.alert("Leave this trip?", "You can take a look at the map without ending it.", [
      { text: "Keep driving", style: "cancel" },
      { text: "Map (keep driving)", onPress: openMenu },
      {
        text: "Cancel trip",
        style: "destructive",
        onPress: () => {
          finishedRef.current = true;
          stopBackgroundTracking();
          navigation.goBack();
        },
      },
    ]);
  };

  const formatEta = (durationSeconds: number) => {
    const totalMin = Math.round(durationSeconds / 60);
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  };
  const formatDistance = (m: number) => formatDistanceShort(m, units);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={{
          latitude: initialRoute[0]?.lat ?? destination.lat,
          longitude: initialRoute[0]?.lng ?? destination.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        <Polyline
          coordinates={plannedRoute.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
          strokeColor={colors.cyan}
          strokeWidth={4}
        />
        <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} title={destinationName} pinColor={colors.gold} />
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
      </MapView>

      <Pressable style={[styles.cancelButton, { top: insets.top + 10 }]} onPress={onCancel} hitSlop={10}>
        <Text style={styles.cancelText}>x</Text>
      </Pressable>

      <Pressable style={[styles.menuButton, { top: insets.top + 10 }]} onPress={openMenu} hitSlop={10}>
        <Text style={styles.menuButtonText}>MAP</Text>
      </Pressable>

      {/* Starts below the x / MAP row rather than covering it. */}
      <View style={[styles.hud, { top: insets.top + 56 }]}>
        <Text style={styles.destName} numberOfLines={1}>
          {destinationName}
        </Text>
        {rerouting && <Text style={styles.rerouteBadge}>REROUTING...</Text>}
        <Text style={styles.time}>{formatDuration(elapsedMs)}</Text>
        <Text style={styles.remaining}>
          {formatDistance(distanceRemainingM)} left -- original ETA {formatEta(durationS)}
        </Text>
        <Text style={styles.speed}>
          {displaySpeedKmh(speedKmh, units)} {speedUnit(units)}{"   "}
          <Text style={styles.topSpeed}>top {displaySpeedKmh(maxSpeedKmh, units)}</Text>
        </Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
      </View>

      <NeonButton
        label={submitting ? "SAVING TRIP..." : "FINISH DRIVE"}
        onPress={onFinishManually}
        disabled={submitting}
        variant="outline"
        style={styles.finishButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
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
  // Beside the x: the map/menu, without ending the drive.
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
  destName: { color: colors.textSecondary, fontSize: 13, textAlign: "center", marginBottom: 4 },
  rerouteBadge: { color: colors.gold, fontSize: 10, fontWeight: "700", textAlign: "center", marginBottom: 4, letterSpacing: 0.5 },
  time: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 38, textAlign: "center" },
  remaining: { color: colors.cyan, fontSize: 13, textAlign: "center", marginTop: 6 },
  speed: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: 8 },
  topSpeed: { color: colors.textMuted, fontSize: 12 },
  progressTrack: { height: 6, backgroundColor: colors.bgElevated, borderRadius: 3, marginTop: 12, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: colors.cyan },
  finishButton: {
    position: "absolute",
    bottom: 30,
    left: 20,
    right: 20,
  },
});
