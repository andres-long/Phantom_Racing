import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { formatDuration } from "../utils/geo";

type Props = NativeStackScreenProps<RootStackParamList, "RunSummary">;

export default function RunSummaryScreen({ route, navigation }: Props) {
  const { result, segmentName, segmentId } = route.params;

  return (
    <View style={styles.container}>
      <Text style={styles.segmentName}>{segmentName}</Text>
      {result.isNewRecord && <Text style={styles.record}>NEW RECORD</Text>}
      <Text style={styles.time}>{formatDuration(result.durationMs)}</Text>
      <Text style={styles.detail}>Avg speed: {result.avgSpeedKmh} km/h</Text>
      <Text style={styles.detail}>Top speed: {Math.round(result.maxSpeedKmh)} km/h</Text>
      <Text style={styles.detail}>
        Rank #{result.rank} of {result.totalRuns}
      </Text>

      <Pressable
        style={styles.button}
        onPress={() => navigation.navigate("Leaderboard", { segmentId, segmentName })}
      >
        <Text style={styles.buttonText}>View leaderboard</Text>
      </Pressable>
      <Pressable style={[styles.button, styles.secondary]} onPress={() => navigation.popToTop()}>
        <Text style={styles.buttonText}>Back to segments</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f", alignItems: "center", justifyContent: "center", padding: 24 },
  segmentName: { color: "#8e8e96", fontSize: 16, marginBottom: 8 },
  record: { color: "#ffd60a", fontWeight: "800", fontSize: 16, marginBottom: 8, letterSpacing: 1 },
  time: { color: "#fff", fontSize: 56, fontWeight: "800" },
  detail: { color: "#c7c7cf", fontSize: 16, marginTop: 8 },
  button: {
    backgroundColor: "#ff3b30",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 32,
    alignItems: "center",
    marginTop: 32,
    width: "100%",
  },
  secondary: { backgroundColor: "#1e1e26", marginTop: 12 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
