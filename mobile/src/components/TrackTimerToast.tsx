import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUser } from "../context/UserContext";
import {
  TrackTimerStatus,
  getTrackTimerStatus,
  subscribeTrackTimer,
  setTrackTimerUser,
  dismissTrackTimerResult,
} from "../trackTimer";
import { navigationRef } from "../navigation/navigationRef";
import { formatDuration } from "../utils/geo";
import { colors, fonts, panelStyle } from "../theme";

// How long the result card stays up on its own.
const RESULT_MS = 9000;

// The background track timer's only UI (see trackTimer.ts): a small tag while
// it's timing you through a track, and a card with your time and where it
// ranks when you reach the end. Floats above every screen.
export default function TrackTimerToast() {
  const { user } = useUser();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<TrackTimerStatus>(getTrackTimerStatus());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setTrackTimerUser(user?.deviceId ?? null);
  }, [user?.deviceId]);

  useEffect(() => subscribeTrackTimer(setStatus), []);

  // The tag's clock ticks between fixes.
  useEffect(() => {
    if (status.kind !== "timing") return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [status.kind]);

  useEffect(() => {
    if (status.kind !== "result") return;
    const t = setTimeout(dismissTrackTimerResult, RESULT_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (!user || status.kind === "idle") return null;

  if (status.kind === "timing" || status.kind === "saving") {
    return (
      <View pointerEvents="none" style={[styles.tag, { top: insets.top + 12 }]}>
        <View style={styles.dot} />
        <Text style={styles.tagText} numberOfLines={1}>
          {status.kind === "timing"
            ? `TIMING: ${status.segmentName}  ${formatDuration(Math.max(0, now - status.startedAt))}`
            : `SAVING: ${status.segmentName}`}
        </Text>
      </View>
    );
  }

  const r = status.result;
  const sectorRecords = (r.sectorIsRecord ?? []).filter(Boolean).length;
  const openBoard = () => {
    dismissTrackTimerResult();
    if (navigationRef.isReady()) {
      navigationRef.navigate("Leaderboard", { segmentId: status.segmentId, segmentName: status.segmentName });
    }
  };
  return (
    <Pressable style={[styles.card, { top: insets.top + 54 }]} onPress={openBoard}>
      <Text style={styles.cardLabel} numberOfLines={1}>
        TRACK TIMED -- {status.segmentName}
      </Text>
      <Text style={styles.cardTime}>{formatDuration(r.durationMs)}</Text>
      <Text style={[styles.cardRank, r.isNewRecord && styles.gold]}>
        {r.isNewRecord ? "NEW TRACK RECORD" : `#${r.rank} of ${r.totalRuns} on the board`}
      </Text>
      {sectorRecords > 0 && !r.isNewRecord && (
        <Text style={styles.cardMeta}>
          {sectorRecords === 1 ? "1 checkpoint record" : `${sectorRecords} checkpoint records`}
        </Text>
      )}
      <Text style={styles.cardHint}>Tap for the leaderboard</Text>
      <Pressable style={styles.close} onPress={dismissTrackTimerResult} hitSlop={10}>
        <Text style={styles.closeText}>x</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tag: {
    position: "absolute",
    // Top right: clear of every screen's x / MAP buttons on the left.
    right: 12,
    maxWidth: "58%",
    flexDirection: "row",
    alignItems: "center",
    ...panelStyle,
    borderColor: colors.gold,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.gold, marginRight: 7 },
  tagText: { color: colors.gold, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  card: {
    position: "absolute",
    left: 20,
    right: 20,
    ...panelStyle,
    borderColor: colors.gold,
    padding: 14,
    alignItems: "center",
  },
  cardLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1, paddingHorizontal: 20 },
  cardTime: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 34, marginTop: 4 },
  cardRank: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 13, marginTop: 4, letterSpacing: 1 },
  gold: { color: colors.gold },
  cardMeta: { color: colors.gold, fontSize: 12, marginTop: 4 },
  cardHint: { color: colors.textMuted, fontSize: 11, marginTop: 6 },
  close: { position: "absolute", top: 6, right: 10 },
  closeText: { color: colors.textSecondary, fontSize: 14, fontWeight: "800" },
});
