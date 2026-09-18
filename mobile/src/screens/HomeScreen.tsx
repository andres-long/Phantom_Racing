import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, Region } from "react-native-maps";
import * as Location from "expo-location";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { cumulativeDistances, projectOntoPolyline, pointAtDistance, haversine } from "../utils/geo";

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

type NearbySegment = SegmentSummary & { distanceM: number };

// The home screen: mostly map. You see yourself (the blue dot), your live
// speed, and any recorded tracks close enough to be worth racing right now.
// Browsing the full list of every track ever recorded lives one tap away
// (the "All tracks" button), since that's a secondary, occasional action.
export default function HomeScreen({ navigation }: Props) {
  const { user } = useUser();
  const mapRef = useRef<MapView | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);

  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [userPos, setUserPos] = useState<LatLng | null>(null);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Whether the map should keep recentering on you as you move. On by
  // default (that's the whole point of this fix -- your position marker
  // used to drift out of view within a few seconds of driving). Turned off
  // the moment you drag the map yourself (onPanDrag, below) so looking
  // around isn't fought every second by an auto-recenter; the recenter
  // button turns it back on. A ref, not state, because it's read from
  // inside the location-watcher closure set up in useFocusEffect.
  const followRef = useRef(true);

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

      return () => {
        cancelled = true;
        subscriptionRef.current?.remove();
        subscriptionRef.current = null;
      };
    }, [loadSegments, navigation])
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
        showsUserLocation
        initialRegion={FALLBACK_REGION}
        onPress={() => setSelectedId(null)}
        onPanDrag={() => {
          followRef.current = false;
        }}
      >
        {nearby.map((s) => {
          const cumDist = cumulativeDistances(s.points);
          const mid = pointAtDistance(s.points, cumDist, cumDist[cumDist.length - 1] / 2);
          const isSelected = s.id === selectedId;
          return (
            <React.Fragment key={s.id}>
              <Polyline
                coordinates={s.points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
                strokeColor={isSelected ? "#ff3b30" : "#3b82f6"}
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

      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.navigate("Username")} hitSlop={8} style={styles.topBarLeft}>
          <Text style={styles.topBarName} numberOfLines={1}>
            {user ? `${user.displayName} >` : "Connecting..."}
          </Text>
        </Pressable>
        <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("AllSegments")}>
          <Text style={styles.topBarButtonText}>All tracks</Text>
        </Pressable>
        <Pressable style={styles.topBarButton} onPress={() => navigation.navigate("Welcome")}>
          <Text style={styles.topBarButtonText}>How it works</Text>
        </Pressable>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Pressable style={styles.recenterButton} onPress={recenter}>
        <Text style={styles.recenterIcon}>o</Text>
      </Pressable>

      <View style={styles.speedHud}>
        {loading ? (
          <ActivityIndicator color="#ff3b30" />
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
            <Pressable
              style={[styles.cardButton, styles.cardButtonPrimary]}
              onPress={() => navigation.navigate("RecordRun", { segmentId: selected.id })}
            >
              <Text style={styles.cardButtonText}>Race it</Text>
            </Pressable>
            <Pressable
              style={styles.cardButton}
              onPress={() => navigation.navigate("Leaderboard", { segmentId: selected.id, segmentName: selected.name })}
            >
              <Text style={styles.cardButtonText}>Leaderboard</Text>
            </Pressable>
          </View>
        </View>
      )}

      <Pressable style={styles.fab} onPress={() => navigation.navigate("CreateSegment")}>
        <Text style={styles.fabText}>+ New segment</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  topBar: {
    position: "absolute",
    top: 50,
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  topBarLeft: {
    flex: 1,
    backgroundColor: "#000000cc",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  topBarName: { color: "#fff", fontWeight: "700", fontSize: 13 },
  topBarButton: {
    backgroundColor: "#000000cc",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  topBarButtonText: { color: "#c7c7cf", fontSize: 12, fontWeight: "600" },
  errorBox: {
    position: "absolute",
    top: 96,
    left: 16,
    right: 16,
    backgroundColor: "#2a1414ee",
    borderRadius: 10,
    padding: 10,
  },
  errorText: { color: "#ff6b6b", fontSize: 12, fontWeight: "600" },
  trackLabel: {
    backgroundColor: "#000000dd",
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1.5,
    borderColor: "#3b82f6",
    maxWidth: 150,
  },
  trackLabelSelected: {
    backgroundColor: "#ff3b30",
    borderColor: "#ff3b30",
  },
  trackLabelText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  recenterButton: {
    position: "absolute",
    right: 16,
    bottom: 170,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#000000cc",
    alignItems: "center",
    justifyContent: "center",
  },
  recenterIcon: { color: "#fff", fontSize: 18, fontWeight: "800" },
  speedHud: {
    position: "absolute",
    left: 16,
    bottom: 100,
    backgroundColor: "#000000cc",
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: "center",
    minWidth: 110,
  },
  speedValue: { color: "#fff", fontSize: 34, fontWeight: "800", lineHeight: 38 },
  speedUnit: { color: "#8e8e96", fontSize: 12, marginBottom: 4 },
  nearbyCount: { color: "#c7c7cf", fontSize: 11, marginTop: 4, textAlign: "center" },
  card: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 100,
    backgroundColor: "#17171dee",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#33333d",
  },
  cardClose: { position: "absolute", top: 10, right: 12, padding: 4 },
  cardCloseText: { color: "#8e8e96", fontSize: 16, fontWeight: "700" },
  cardTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 4, paddingRight: 24 },
  cardMeta: { color: "#9c9ca6", fontSize: 13, marginTop: 2 },
  cardActions: { flexDirection: "row", marginTop: 12, gap: 10 },
  cardButton: { flex: 1, backgroundColor: "#26262f", paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  cardButtonPrimary: { backgroundColor: "#ff3b30" },
  cardButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  fab: {
    position: "absolute",
    bottom: 24,
    left: 20,
    width: "44%",
    backgroundColor: "#1e1e26",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#33333d",
  },
  fabText: { color: "#fff", fontWeight: "700" },
});
