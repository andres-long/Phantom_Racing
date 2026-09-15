import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary } from "../types";
import { api } from "../api/client";

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
        <ActivityIndicator color="#ff3b30" size="large" />
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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff3b30" />}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No segments recorded yet. Record one from the map.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.cardMeta}>
              {(item.lengthM / 1000).toFixed(2)} km -- {item.runCount} run{item.runCount === 1 ? "" : "s"}
            </Text>
            <Text style={styles.cardMeta}>
              {item.bestTimeMs != null
                ? `Best ${(item.bestTimeMs / 1000).toFixed(1)}s by ${item.bestTimeUser}`
                : "No runs yet -- be the first"}
            </Text>
            <View style={styles.cardActions}>
              <Pressable
                style={[styles.cardButton, styles.cardButtonPrimary]}
                onPress={() => navigation.navigate("RecordRun", { segmentId: item.id })}
              >
                <Text style={styles.cardButtonText}>Race it</Text>
              </Pressable>
              <Pressable
                style={styles.cardButton}
                onPress={() => navigation.navigate("Leaderboard", { segmentId: item.id, segmentName: item.name })}
              >
                <Text style={styles.cardButtonText}>Leaderboard</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { color: "#8e8e96", fontSize: 14, textAlign: "center" },
  errorBox: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: "#2a1414ee",
    borderRadius: 10,
    padding: 10,
  },
  errorText: { color: "#ff6b6b", fontSize: 12, fontWeight: "600" },
  list: { padding: 16, paddingBottom: 32 },
  card: {
    backgroundColor: "#17171d",
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#33333d",
  },
  cardTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 4 },
  cardMeta: { color: "#9c9ca6", fontSize: 13, marginTop: 2 },
  cardActions: { flexDirection: "row", marginTop: 12, gap: 10 },
  cardButton: { flex: 1, backgroundColor: "#26262f", paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  cardButtonPrimary: { backgroundColor: "#ff3b30" },
  cardButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
});
