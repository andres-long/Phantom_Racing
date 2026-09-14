import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LeaderboardEntry } from "../types";
import { api } from "../api/client";
import { formatDuration } from "../utils/geo";

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
      <Text style={styles.title}>{segmentName}</Text>
      {loading && <ActivityIndicator color="#ff3b30" style={{ marginTop: 24 }} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={entries}
        keyExtractor={(e) => e.runId}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>No runs yet.</Text> : null}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rank}>#{item.rank}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.displayName}</Text>
              <Text style={styles.meta}>{item.avgSpeedKmh} km/h avg</Text>
            </View>
            <Text style={styles.time}>{formatDuration(item.durationMs)}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f", paddingTop: 60 },
  title: { color: "#fff", fontSize: 24, fontWeight: "700", paddingHorizontal: 20 },
  error: { color: "#ff6b6b", paddingHorizontal: 20, marginTop: 12 },
  empty: { color: "#8e8e96", textAlign: "center", marginTop: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#17171d",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  rank: { color: "#ff3b30", fontWeight: "800", fontSize: 16, width: 40 },
  name: { color: "#fff", fontWeight: "600", fontSize: 15 },
  meta: { color: "#8e8e96", fontSize: 12, marginTop: 2 },
  time: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
