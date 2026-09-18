import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { formatDuration } from "../utils/geo";
import { colors, fonts } from "../theme";
import GridBackground from "../components/GridBackground";
import NeonButton from "../components/NeonButton";

type Props = NativeStackScreenProps<RootStackParamList, "RunSummary">;

export default function RunSummaryScreen({ route, navigation }: Props) {
  const { result, segmentName, segmentId } = route.params;

  return (
    <View style={styles.container}>
      <GridBackground />
      <Text style={styles.segmentName}>{segmentName}</Text>
      {result.isNewRecord && <Text style={styles.record}>NEW RECORD</Text>}
      <Text style={styles.time}>{formatDuration(result.durationMs)}</Text>
      <Text style={styles.detail}>Avg speed: {result.avgSpeedKmh} km/h</Text>
      <Text style={styles.detail}>Top speed: {Math.round(result.maxSpeedKmh)} km/h</Text>
      <Text style={styles.detail}>
        Rank #{result.rank} of {result.totalRuns}
      </Text>

      <NeonButton
        label="VIEW LEADERBOARD"
        onPress={() => navigation.navigate("Leaderboard", { segmentId, segmentName })}
        style={styles.button}
      />
      <NeonButton
        label="BACK TO SEGMENTS"
        onPress={() => navigation.popToTop()}
        variant="outline"
        style={styles.button}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  segmentName: { color: colors.textSecondary, fontSize: 15, marginBottom: 10, letterSpacing: 0.5 },
  record: {
    color: colors.gold,
    fontFamily: fonts.heading,
    fontSize: 15,
    marginBottom: 10,
    letterSpacing: 3,
  },
  time: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 52 },
  detail: { color: colors.textSecondary, fontSize: 16, marginTop: 8 },
  button: {
    marginTop: 16,
    width: "100%",
  },
});
