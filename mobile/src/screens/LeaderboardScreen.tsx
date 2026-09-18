import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LeaderboardEntry } from "../types";
import { api } from "../api/client";
import { formatDuration } from "../utils/geo";
import { colors, fonts, panelStyle } from "../theme";
import GridBackground from "../components/GridBackground";

type Props = NativeStackScreenProps<RootStackParamList, "Leaderboard">;

export default function LeaderboardScreen({ route }: Props) {
  const { segmentId, segmentName } = route.params;
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getLeaderboard(segmentId)
      .then((res) => setEntries(res.leaderboard))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [segmentId]);

  return (
    <View style={styles.container}>
      <GridBackground />
      <Text style={styles.title}>{segmentName}</Text>
      {loading && <ActivityIndicator color={colors.cyan} style={{ marginTop: 24 }} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={entries}
        keyExtractor={(e) => e.runId}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>No runs yet.</Text> : null}
        renderItem={({ item }) => (
          <View style={[styles.row, item.rank === 1 && styles.rowLeader]}>
            <Text style={[styles.rank, item.rank === 1 && styles.rankLeader]}>#{item.rank}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.displayName}</Text>
              <Text style={styles.meta}>
                {item.avgSpeedKmh} km/h avg . {Math.round(item.maxSpeedKmh)} km/h top
              </Text>
            </View>
            <Text style={styles.time}>{formatDuration(item.durationMs)}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: 60 },
  title: {
    color: colors.textPrimary,
    fontFamily: fonts.heading,
    fontSize: 18,
    paddingHorizontal: 20,
    letterSpacing: 1,
  },
  error: { color: colors.danger, paddingHorizontal: 20, marginTop: 12 },
  empty: { color: colors.textSecondary, textAlign: "center", marginTop: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    ...panelStyle,
    padding: 14,
    marginBottom: 10,
  },
  rowLeader: { borderColor: colors.gold, backgroundColor: "rgba(255, 207, 61, 0.08)" },
  rank: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 15, width: 40 },
  rankLeader: { color: colors.gold },
  name: { color: colors.textPrimary, fontWeight: "600", fontSize: 15 },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  time: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 15 },
});
