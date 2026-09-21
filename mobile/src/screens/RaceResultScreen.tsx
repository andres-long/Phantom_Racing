import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, RaceChallenge } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { formatDuration } from "../utils/geo";
import { displaySpeedKmh, speedUnit } from "../utils/units";
import { colors, fonts } from "../theme";
import GridBackground from "../components/GridBackground";
import NeonButton from "../components/NeonButton";

type Props = NativeStackScreenProps<RootStackParamList, "RaceResult">;

// How often to re-check the race while we're waiting on the opponent to
// finish their own side of it.
const POLL_INTERVAL_MS = 2000;

// Shown right after a live race ends -- for us, at least (finishRace on
// RaceLiveScreen already submitted our own result by the time this screen
// mounts). If the opponent hasn't crossed the finish distance yet, this
// polls until they do, then declares a winner by comparing how long each
// side took to cover the same target distance -- the plain drag-race rule,
// even though the "track" was whatever real road each of them was on.
export default function RaceResultScreen({ route, navigation }: Props) {
  const { raceId } = route.params;
  const { user, units } = useUser();

  const [race, setRace] = useState<RaceChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const r = await api.getRaceChallenge(raceId, user.deviceId);
        if (cancelled) return;
        setRace(r);
        if (r.myResult && r.opponentResult) {
          pollingRef.current = false;
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || "Couldn't load the result.");
      }
    };

    poll();
    const t = setInterval(() => {
      if (pollingRef.current) poll();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [raceId, user]);

  if (error) {
    return (
      <View style={styles.container}>
        <GridBackground />
        <Text style={styles.errorText}>{error}</Text>
        <NeonButton label="BACK TO MAP" onPress={() => navigation.popToTop()} style={styles.button} />
      </View>
    );
  }

  if (!race || !race.myResult) {
    return (
      <View style={styles.container}>
        <GridBackground />
        <ActivityIndicator color={colors.cyan} size="large" />
        <Text style={styles.waitingText}>Wrapping up...</Text>
      </View>
    );
  }

  const waitingOnOpponent = !race.opponentResult;
  const iWon =
    race.opponentResult && race.myResult.durationMs !== race.opponentResult.durationMs
      ? race.myResult.durationMs < race.opponentResult.durationMs
      : null;
  const isTie = race.opponentResult && race.myResult.durationMs === race.opponentResult.durationMs;

  return (
    <View style={styles.container}>
      <GridBackground />
      <Text style={styles.distanceLabel}>{race.distanceLabel} -- VS {race.opponentDisplayName}</Text>

      {waitingOnOpponent ? (
        <>
          <Text style={styles.waitingHeadline}>YOU FINISHED</Text>
          <ActivityIndicator color={colors.cyan} style={styles.waitingSpinner} />
          <Text style={styles.waitingText}>Waiting for {race.opponentDisplayName} to finish...</Text>
        </>
      ) : isTie ? (
        <Text style={styles.tie}>DEAD HEAT</Text>
      ) : (
        <Text style={iWon ? styles.win : styles.lose}>{iWon ? "YOU WIN" : "YOU LOSE"}</Text>
      )}

      <View style={styles.resultsRow}>
        <View style={styles.resultCol}>
          <Text style={styles.resultName} numberOfLines={1}>
            YOU
          </Text>
          <Text style={styles.resultTime}>{formatDuration(race.myResult.durationMs)}</Text>
          <Text style={styles.resultDetail}>
            avg {displaySpeedKmh(race.myResult.avgSpeedKmh, units)} {speedUnit(units)}
          </Text>
          <Text style={styles.resultDetail}>
            top {displaySpeedKmh(race.myResult.maxSpeedKmh, units)} {speedUnit(units)}
          </Text>
        </View>
        <Text style={styles.vsDivider}>VS</Text>
        <View style={styles.resultCol}>
          <Text style={styles.resultName} numberOfLines={1}>
            {race.opponentDisplayName.toUpperCase()}
          </Text>
          {race.opponentResult ? (
            <>
              <Text style={styles.resultTime}>{formatDuration(race.opponentResult.durationMs)}</Text>
              <Text style={styles.resultDetail}>
                avg {displaySpeedKmh(race.opponentResult.avgSpeedKmh, units)} {speedUnit(units)}
              </Text>
              <Text style={styles.resultDetail}>
                top {displaySpeedKmh(race.opponentResult.maxSpeedKmh, units)} {speedUnit(units)}
              </Text>
            </>
          ) : (
            <Text style={styles.resultPending}>racing...</Text>
          )}
        </View>
      </View>

      <NeonButton label="BACK TO MAP" onPress={() => navigation.popToTop()} style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: colors.danger, fontSize: 14, fontWeight: "600", textAlign: "center", marginBottom: 16 },
  distanceLabel: { color: colors.textSecondary, fontSize: 13, letterSpacing: 0.5, marginBottom: 16, textAlign: "center" },
  waitingHeadline: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 22, letterSpacing: 2 },
  waitingSpinner: { marginTop: 20 },
  waitingText: { color: colors.textSecondary, fontSize: 14, marginTop: 14, textAlign: "center" },
  win: { color: colors.cyan, fontFamily: fonts.display, fontSize: 40, letterSpacing: 2, textAlign: "center" },
  lose: { color: colors.danger, fontFamily: fonts.display, fontSize: 40, letterSpacing: 2, textAlign: "center" },
  tie: { color: colors.gold, fontFamily: fonts.display, fontSize: 34, letterSpacing: 2, textAlign: "center" },
  resultsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "center",
    marginTop: 28,
    width: "100%",
  },
  resultCol: { flex: 1, alignItems: "center" },
  vsDivider: { color: colors.textMuted, fontSize: 12, fontWeight: "700", marginTop: 24, paddingHorizontal: 10 },
  resultName: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginBottom: 6 },
  resultTime: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 26 },
  resultDetail: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  resultPending: { color: colors.textMuted, fontSize: 13, marginTop: 10, fontStyle: "italic" },
  button: { marginTop: 36, width: "100%" },
});
