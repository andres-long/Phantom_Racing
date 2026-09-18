import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary } from "../types";
import { api } from "../api/client";
import { colors, fonts, panelStyle } from "../theme";
import NeonButton from "../components/NeonButton";
import TrackPreview from "../components/TrackPreview";

type Props = NativeStackScreenProps<RootStackParamList, "AllSegments">;

// The full browsable list of every segment ever recorded, regardless of how
// close it is to you right now. Home shows only what's nearby on the map;
// this is the "everything" view for picking a track from anywhere.
export default function AllSegmentsScreen({ navigation }: Props) {
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    try {
      setError(null);
      const data = await api.listSegments();
      setSegments(data);
    } catch (e: any) {
      setError(e.message || "Couldn't reach the backend.");
    } finally {
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
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
        data={segments}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No segments recorded yet. Record one from the map.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <TrackPreview points={item.points} />
            <Text style={styles.cardMeta}>
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
          </View>
        )}
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
  cardTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 16, marginBottom: 6 },
  cardMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  cardActions: { flexDirection: "row", marginTop: 14, gap: 10 },
  cardButton: { flex: 1 },
});
