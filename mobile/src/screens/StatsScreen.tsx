import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { colors, fonts, panelStyle } from "../theme";
import GridBackground from "../components/GridBackground";

type Props = NativeStackScreenProps<RootStackParamList, "Stats">;

type Totals = {
  topSpeedKmh: number;
  distanceM: number;
  avgSpeedKmh: number;
  driveCount: number;
};

// Your lifetime numbers across everything you've driven in the app --
// segment runs (racing a track) and Go To trips (driving to a place) both
// count. Average speed is distance-weighted (total distance / total time),
// not a plain mean of each drive's own average, so a handful of long
// highway drives don't get outweighed by a lot of short, slow ones.
export default function StatsScreen({}: Props) {
  const { user } = useUser();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setError(null);
        const [runs, trips] = await Promise.all([
          api.getUserRuns(user.deviceId),
          api.getUserTrips(user.deviceId),
        ]);

        let distanceM = 0;
        let durationMs = 0;
        let topSpeedKmh = 0;
        for (const r of runs) {
          distanceM += r.distanceM;
          durationMs += r.durationMs;
          if (r.maxSpeedKmh > topSpeedKmh) topSpeedKmh = r.maxSpeedKmh;
        }
        for (const t of trips) {
          distanceM += t.distanceM;
          durationMs += t.durationMs;
          if (t.maxSpeedKmh > topSpeedKmh) topSpeedKmh = t.maxSpeedKmh;
        }

        setTotals({
          topSpeedKmh,
          distanceM,
          avgSpeedKmh: durationMs > 0 ? (distanceM / 1000 / (durationMs / 3_600_000)) : 0,
          driveCount: runs.length + trips.length,
        });
      } catch (e: any) {
        setError(e.message || "Couldn't reach the backend.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

  return (
    <View style={styles.container}>
      <GridBackground />
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <ActivityIndicator color={colors.cyan} style={{ marginTop: 40 }} />
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : totals && totals.driveCount > 0 ? (
          <>
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>TOP SPEED</Text>
              <Text style={styles.tileValue}>{Math.round(totals.topSpeedKmh)}</Text>
              <Text style={styles.tileUnit}>km/h</Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>DISTANCE DRIVEN</Text>
              <Text style={styles.tileValue}>{formatDistance(totals.distanceM).split(" ")[0]}</Text>
              <Text style={styles.tileUnit}>{formatDistance(totals.distanceM).split(" ")[1]}</Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>AVERAGE SPEED</Text>
              <Text style={styles.tileValue}>{Math.round(totals.avgSpeedKmh)}</Text>
              <Text style={styles.tileUnit}>km/h</Text>
            </View>
            <Text style={styles.footnote}>
              Based on {totals.driveCount} drive{totals.driveCount === 1 ? "" : "s"} -- segment runs and Go To
              trips combined.
            </Text>
          </>
        ) : (
          <Text style={styles.empty}>No drives recorded yet -- race a segment or go somewhere to start building stats.</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 40 },
  error: { color: colors.danger, textAlign: "center", marginTop: 40, paddingHorizontal: 20 },
  empty: { color: colors.textSecondary, textAlign: "center", marginTop: 40, paddingHorizontal: 20, fontSize: 14 },
  tile: {
    ...panelStyle,
    padding: 20,
    alignItems: "center",
    marginBottom: 14,
  },
  tileLabel: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5 },
  tileValue: { color: colors.cyan, fontFamily: fonts.display, fontSize: 44, lineHeight: 52, marginTop: 6 },
  tileUnit: { color: colors.textSecondary, fontSize: 12, letterSpacing: 1, marginTop: 2 },
  footnote: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 8 },
});
