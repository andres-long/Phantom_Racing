import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { formatDuration } from "../utils/geo";
import { displaySpeedKmh, speedUnit, formatDistanceLong } from "../utils/units";
import { useUser } from "../context/UserContext";
import { colors, fonts } from "../theme";
import GridBackground from "../components/GridBackground";
import NeonButton from "../components/NeonButton";

type Props = NativeStackScreenProps<RootStackParamList, "GoSummary">;

// Mirrors RunSummaryScreen's layout (same "big time, a few stats, two
// buttons" shape every result screen in the app uses) but for a point-to-
// point trip: no rank/leaderboard since every trip starts from wherever you
// happened to be, just how the actual drive compared to Google's ETA from
// before you left.
export default function GoSummaryScreen({ route, navigation }: Props) {
  const { result } = route.params;
  const { units } = useUser();
  const beatEstimate = result.deltaMs != null ? result.deltaMs <= 0 : null;

  return (
    <View style={styles.container}>
      <GridBackground />
      <Text style={styles.destName}>{result.destinationName}</Text>
      {beatEstimate != null && (
        <Text style={[styles.badge, { color: beatEstimate ? colors.cyan : colors.racePrimary }]}>
          {beatEstimate ? "BEAT THE ESTIMATE" : "TOOK LONGER THAN ESTIMATED"}
        </Text>
      )}
      <Text style={styles.time}>{formatDuration(result.durationMs)}</Text>
      {result.deltaMs != null && (
        <Text style={styles.detail}>
          {beatEstimate ? "-" : "+"}
          {formatDuration(Math.abs(result.deltaMs))} vs the original ETA
        </Text>
      )}
      <Text style={styles.detail}>Distance: {formatDistanceLong(result.distanceM, units, 1)}</Text>
      <Text style={styles.detail}>
        Avg speed: {displaySpeedKmh(result.avgSpeedKmh, units)} {speedUnit(units)}
      </Text>
      <Text style={styles.detail}>
        Top speed: {displaySpeedKmh(result.maxSpeedKmh, units)} {speedUnit(units)}
      </Text>

      <NeonButton label="GO SOMEWHERE ELSE" onPress={() => navigation.replace("GoTo")} style={styles.button} />
      <NeonButton label="BACK HOME" onPress={() => navigation.popToTop()} variant="outline" style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  destName: { color: colors.textSecondary, fontSize: 15, marginBottom: 10, letterSpacing: 0.5, textAlign: "center" },
  badge: { fontFamily: fonts.heading, fontSize: 14, marginBottom: 10, letterSpacing: 2, textAlign: "center" },
  time: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 52 },
  detail: { color: colors.textSecondary, fontSize: 16, marginTop: 8 },
  button: { marginTop: 16, width: "100%" },
});
