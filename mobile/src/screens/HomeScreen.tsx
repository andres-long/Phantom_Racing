import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, RefreshControl, ActivityIndicator } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, SegmentSummary } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export default function HomeScreen({ navigation }: Props) {
  const { user } = useUser();
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
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

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Segments</Text>
            <Pressable onPress={() => navigation.navigate("Username")} hitSlop={8}>
              <Text style={styles.subtitle}>
                {user ? `Racing as ${user.displayName} >` : "Connecting..."}
              </Text>
            </Pressable>
          </View>
          <Pressable
            style={styles.settingsButton}
            onPress={() => navigation.navigate("Welcome")}
            hitSlop={8}
          >
            <Text style={styles.settingsButtonText}>How it works</Text>
          </Pressable>
        </View>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>
            Check API_BASE_URL in src/api/client.ts -- it needs to point at your computer's LAN
            IP when testing on a physical phone.
          </Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#ff3b30" />
      ) : (
        <FlatList
          data={segments}
          keyExtractor={(s) => s.id}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor="#fff" />}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <Text style={styles.empty}>No segments yet. Record one from a drive you already do.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.cardMeta}>
                {(item.lengthM / 1000).toFixed(2)} km
                {item.bestTimeMs != null
                  ? ` -- best ${(item.bestTimeMs / 1000).toFixed(1)}s by ${item.bestTimeUser}`
                  : " -- no runs yet, be the first"}
              </Text>
              <View style={styles.cardActions}>
                <Pressable
                  style={[styles.smallButton, styles.primaryButton]}
                  onPress={() => navigation.navigate("RecordRun", { segmentId: item.id })}
                >
                  <Text style={styles.smallButtonText}>Race it</Text>
                </Pressable>
                <Pressable
                  style={styles.smallButton}
                  onPress={() => navigation.navigate("Leaderboard", { segmentId: item.id, segmentName: item.name })}
                >
                  <Text style={styles.smallButtonText}>Leaderboard</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}

      <Pressable style={styles.fab} onPress={() => navigation.navigate("CreateSegment")}>
        <Text style={styles.fabText}>+ New segment</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 10 },
  headerRow: { flexDirection: "row", alignItems: "flex-start" },
  title: { color: "#fff", fontSize: 30, fontWeight: "700" },
  subtitle: { color: "#8e8e96", fontSize: 14, marginTop: 4 },
  settingsButton: {
    backgroundColor: "#17171d",
    borderWidth: 1,
    borderColor: "#33333d",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  settingsButtonText: { color: "#c7c7cf", fontSize: 12, fontWeight: "600" },
  errorBox: { margin: 16, padding: 14, backgroundColor: "#2a1414", borderRadius: 12 },
  errorText: { color: "#ff6b6b", fontWeight: "600" },
  errorHint: { color: "#c79a9a", fontSize: 12, marginTop: 6 },
  empty: { color: "#8e8e96", textAlign: "center", marginTop: 40 },
  card: { backgroundColor: "#17171d", borderRadius: 16, padding: 16, marginBottom: 12 },
  cardTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  cardMeta: { color: "#9c9ca6", fontSize: 13, marginTop: 4 },
  cardActions: { flexDirection: "row", marginTop: 12, gap: 10 },
  smallButton: { backgroundColor: "#26262f", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  primaryButton: { backgroundColor: "#ff3b30" },
  smallButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 20,
    left: 20,
    backgroundColor: "#1e1e26",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#33333d",
  },
  fabText: { color: "#fff", fontWeight: "700" },
});
