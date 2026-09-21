import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as Location from "expo-location";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { cumulativeDistances, projectOntoPolyline } from "../utils/geo";
import { colors, fonts, panelStyle } from "../theme";
import NeonButton from "../components/NeonButton";
import TrackPreview from "../components/TrackPreview";

type Props = NativeStackScreenProps<RootStackParamList, "AllSegments">;

type SortedSegment = SegmentSummary & { distanceM: number | null };

// The full browsable list of every segment ever recorded, regardless of how
// close it is to you right now. Home shows only what's nearby on the map;
// this is the "everything" view for picking a track from anywhere -- sorted
// closest-first so the road you're most likely to actually drive today is
// at the top, not buried under everything anyone's ever recorded.
export default function AllSegmentsScreen({ navigation }: Props) {
  const { user } = useUser();
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [userPos, setUserPos] = useState<LatLng | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh: boolean) => {
      try {
        setError(null);
        const data = await api.listSegments(user?.deviceId);
        setSegments(data);
      } catch (e: any) {
        setError(e.message || "Couldn't reach the backend.");
      } finally {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [user?.deviceId]
  );

  // One-shot location fix (not a live watch -- this list isn't a map, it
  // just needs "where am I right now" once to sort by). Best-effort: if
  // permission isn't granted or the fix fails, the list just falls back to
  // whatever order the server returned instead of blocking on it.
  const loadLocation = useCallback(async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      let granted = status === "granted";
      if (!granted) {
        const req = await Location.requestForegroundPermissionsAsync();
        granted = req.status === "granted";
      }
      if (!granted) return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setUserPos({ lat: loc.coords.latitude, lng: loc.coords.longitude });
    } catch {
      // No fix available -- list stays in server order.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(false);
      loadLocation();
    }, [load, loadLocation])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const sorted: SortedSegment[] = useMemo(() => {
    if (!userPos) return segments.map((s) => ({ ...s, distanceM: null }));
    return segments
      .map((s) => {
        if (s.points.length < 2) return { ...s, distanceM: null };
        const cumDist = cumulativeDistances(s.points);
        const { lateralDistanceM } = projectOntoPolyline(s.points, cumDist, userPos);
        return { ...s, distanceM: lateralDistanceM };
      })
      .sort((a, b) => {
        if (a.distanceM == null && b.distanceM == null) return 0;
        if (a.distanceM == null) return 1;
        if (b.distanceM == null) return -1;
        return a.distanceM - b.distanceM;
      });
  }, [segments, userPos]);

  const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)}m away` : `${(m / 1000).toFixed(1)}km away`);

  const togglePrivacy = async (segment: SortedSegment) => {
    if (!user) return;
    setTogglingId(segment.id);
    try {
      await api.setSegmentPrivacy(segment.id, user.deviceId, !segment.isPrivate);
      await load(false);
    } catch (e: any) {
      Alert.alert("Couldn't update", e.message || "Unknown error");
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <FlatList
        data={sorted}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No segments recorded yet. Record one from the map.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isOwner = !!user && item.creatorId === user.id;
          return (
            <View style={styles.card}>
              <View style={styles.cardTitleRow}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                {item.isPrivate && (
                  <View style={styles.privateBadge}>
                    <Text style={styles.privateBadgeText}>PRIVATE</Text>
                  </View>
                )}
              </View>
              <TrackPreview points={item.points} />
              <Text style={styles.cardMeta}>
                {item.distanceM != null ? `${formatDistance(item.distanceM)} -- ` : ""}
                {(item.lengthM / 1000).toFixed(2)} km -- {item.runCount} run{item.runCount === 1 ? "" : "s"}
              </Text>
              <Text style={styles.cardMeta}>
                {item.bestTimeMs != null
                  ? `Best ${(item.bestTimeMs / 1000).toFixed(1)}s by ${item.bestTimeUser}`
                  : "No runs yet -- be the first"}
              </Text>
              <View style={styles.cardActions}>
                <NeonButton
                  label="RACE IT"
                  onPress={() => navigation.navigate("RecordRun", { segmentId: item.id })}
                  style={styles.cardButton}
                />
                <NeonButton
                  label="LEADERBOARD"
                  variant="outline"
                  onPress={() => navigation.navigate("Leaderboard", { segmentId: item.id, segmentName: item.name })}
                  style={styles.cardButton}
                />
              </View>
              {isOwner && (
                <NeonButton
                  label={
                    togglingId === item.id
                      ? "UPDATING..."
                      : item.isPrivate
                      ? "MAKE PUBLIC"
                      : "MAKE PRIVATE"
                  }
                  variant="ghost"
                  disabled={togglingId === item.id}
                  onPress={() => togglePrivacy(item)}
                  style={styles.privacyButton}
                />
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },
  errorBox: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: "#2a1414ee",
    borderRadius: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 12, fontWeight: "600" },
  list: { padding: 16, paddingBottom: 32 },
  card: { ...panelStyle, padding: 16, marginBottom: 12 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  cardTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 16, flexShrink: 1 },
  privateBadge: {
    borderWidth: 1,
    borderColor: colors.racePrimary,
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  privateBadgeText: { color: colors.racePrimary, fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  cardMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  cardActions: { flexDirection: "row", marginTop: 14, gap: 10 },
  cardButton: { flex: 1 },
  privacyButton: { marginTop: 4 },
});
