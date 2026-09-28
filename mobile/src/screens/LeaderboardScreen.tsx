import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LeaderboardEntry, TrackCheckpoint } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { formatDuration } from "../utils/geo";
import { displaySpeedKmh, speedUnit } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";
import GridBackground from "../components/GridBackground";
import { CHECKPOINT_NAMES } from "../components/SplitsTable";

type Props = NativeStackScreenProps<RootStackParamList, "Leaderboard">;

export default function LeaderboardScreen({ route }: Props) {
  const { segmentId, segmentName } = route.params;
  const { user, units } = useUser();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<TrackCheckpoint[]>([]);

  useEffect(() => {
    // deviceId included so a private track's creator can still see its
    // leaderboard.
    api
      .getLeaderboard(segmentId, user?.deviceId)
      .then((res) => setEntries(res.leaderboard))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // The quarter-by-quarter records -- a nicety, the board works without.
    api
      .getCheckpoints(segmentId, user?.deviceId)
      .then((res) => setCheckpoints(res.checkpoints))
      .catch(() => {});
  }, [segmentId, user?.deviceId]);

  const hasCheckpointRecords = checkpoints.some((c) => c.bestSectorMs != null);
  const checkpointHeader = hasCheckpointRecords ? (
    <View style={styles.cpPanel}>
      <Text style={styles.cpTitle}>CHECKPOINT RECORDS</Text>
      {checkpoints.map((c) => (
        <View key={c.index} style={styles.cpRow}>
          <Text style={styles.cpName}>{CHECKPOINT_NAMES[c.index - 1] ?? `CP ${c.index}`}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.cpBy} numberOfLines={1}>
              {c.bestSectorBy ?? "--"}
            </Text>
            {c.fraction < 1 && c.bestSplitMs != null && (
              <Text style={styles.cpSplit} numberOfLines={1}>
                fastest to here {formatDuration(c.bestSplitMs)} ({c.bestSplitBy})
              </Text>
            )}
          </View>
          <Text style={styles.cpTime}>{c.bestSectorMs != null ? formatDuration(c.bestSectorMs) : "--"}</Text>
        </View>
      ))}
    </View>
  ) : null;

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
        ListHeaderComponent={checkpointHeader}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>No runs yet.</Text> : null}
        renderItem={({ item }) => (
          <View style={[styles.row, item.rank === 1 && styles.rowLeader]}>
            <Text style={[styles.rank, item.rank === 1 && styles.rankLeader]}>#{item.rank}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.displayName}</Text>
              <Text style={styles.meta}>
                {displaySpeedKmh(item.avgSpeedKmh, units)} {speedUnit(units)} avg . {displaySpeedKmh(item.maxSpeedKmh, units)}{" "}
                {speedUnit(units)} top
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
  cpPanel: { ...panelStyle, borderColor: colors.gold, padding: 14, marginBottom: 14 },
  cpTitle: { color: colors.gold, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5, marginBottom: 6 },
  cpRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.divider },
  cpName: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", width: 92, letterSpacing: 0.5 },
  cpBy: { color: colors.textPrimary, fontSize: 13, fontWeight: "600" },
  cpSplit: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  cpTime: { color: colors.gold, fontFamily: fonts.heading, fontSize: 14 },
});
