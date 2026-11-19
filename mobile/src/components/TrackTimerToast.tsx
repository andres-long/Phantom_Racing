import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUser } from "../context/UserContext";
import {
  TrackTimerStatus,
  getTrackTimerStatus,
  subscribeTrackTimer,
  setTrackTimerUser,
  dismissTrackTimerResult,
  saveSuggestedTrack,
  showDriveSummary,
} from "../trackTimer";
import { navigationRef } from "../navigation/navigationRef";
import { formatDuration } from "../utils/geo";
import { displaySpeedKmh, speedUnit, formatDistanceLong } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";

// How long each card stays up on its own.
const RESULT_MS = 9000;
const SUMMARY_MS = 30000;
const SUGGEST_MS = 90000;

// The background track timer's only UI (see trackTimer.ts): a small tag while
// it's timing you through a track, and a card with your time and where it
// ranks when you reach the end. Floats above every screen.
export default function TrackTimerToast() {
  const { user, units } = useUser();
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

  // Cards time out on their own (a suggestion that times out isn't a "no").
  useEffect(() => {
    const ms =
      status.kind === "result" || status.kind === "saved"
        ? RESULT_MS
        : status.kind === "summary"
        ? SUMMARY_MS
        : status.kind === "suggest"
        ? SUGGEST_MS
        : 0;
    if (!ms) return;
    const t = setTimeout(() => dismissTrackTimerResult(false), ms);
    return () => clearTimeout(t);
  }, [status]);

  if (!user || status.kind === "idle") return null;

  if (status.kind === "suggest") return <SuggestCard key={status.suggestion.name} status={status} top={insets.top + 54} />;

  if (status.kind === "saved") {
    const openSaved = () => {
      dismissTrackTimerResult();
      if (navigationRef.isReady()) {
        navigationRef.navigate("Leaderboard", { segmentId: status.segmentId, segmentName: status.segmentName });
      }
    };
    return (
      <Pressable style={[styles.card, { top: insets.top + 54 }]} onPress={openSaved}>
        <Text style={styles.cardLabel} numberOfLines={1}>
          NEW TRACK SAVED
        </Text>
        <Text style={styles.savedName} numberOfLines={1}>
          {status.segmentName}
        </Text>
        <Text style={styles.cardRank}>
          {status.result ? `Your time: ${formatDuration(status.result.durationMs)} -- the one to beat` : "Race it next time you pass"}
        </Text>
        <Text style={[styles.cardHint, { marginTop: 6 }]}>Tap for its leaderboard</Text>
        <Pressable style={styles.close} onPress={() => dismissTrackTimerResult()} hitSlop={10}>
          <Text style={styles.closeText}>x</Text>
        </Pressable>
      </Pressable>
    );
  }

  if (status.kind === "summary") {
    const open = (segmentId: string, segmentName: string) => {
      dismissTrackTimerResult();
      if (navigationRef.isReady()) navigationRef.navigate("Leaderboard", { segmentId, segmentName });
    };
    const records = status.entries.filter((e) => e.isNewRecord).length;
    return (
      <View style={[styles.card, styles.summaryCard, { top: insets.top + 54 }]}>
        <Text style={styles.cardLabel}>THIS DRIVE</Text>
        <Text style={styles.summaryHead}>
          {status.entries.length} track{status.entries.length === 1 ? "" : "s"} timed
          {records > 0 ? ` -- ${records} record${records === 1 ? "" : "s"}` : ""}
        </Text>
        {status.entries.slice(-6).map((e, i) => (
          <Pressable key={`${e.segmentId}-${i}`} style={styles.summaryRow} onPress={() => open(e.segmentId, e.segmentName)}>
            <Text style={styles.summaryName} numberOfLines={1}>
              {e.segmentName}
              {e.lap > 1 ? `  lap ${e.lap}` : ""}
            </Text>
            <Text style={styles.summaryTime}>{formatDuration(e.durationMs)}</Text>
            <Text style={[styles.summaryRank, e.isNewRecord && styles.gold]}>
              {e.isNewRecord ? "RECORD" : `#${e.rank}`}
            </Text>
          </Pressable>
        ))}
        {status.entries.length > 6 && (
          <Text style={styles.cardHint}>+ {status.entries.length - 6} earlier</Text>
        )}
        <Pressable style={styles.close} onPress={() => dismissTrackTimerResult()} hitSlop={10}>
          <Text style={styles.closeText}>x</Text>
        </Pressable>
      </View>
    );
  }

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
  const shareRun = () => {
    dismissTrackTimerResult();
    if (!navigationRef.isReady()) return;
    navigationRef.navigate("ShareDrive", {
      title: status.segmentName.toUpperCase(),
      subtitle: r.isNewRecord ? "NEW TRACK RECORD" : `#${r.rank} OF ${r.totalRuns}`,
      stats: [
        { label: "Time", value: formatDuration(r.durationMs) },
        { label: "Avg speed", value: `${displaySpeedKmh(r.avgSpeedKmh, units)} ${speedUnit(units)}` },
        { label: "Top speed", value: `${displaySpeedKmh(r.maxSpeedKmh, units)} ${speedUnit(units)}` },
      ],
      segmentId: status.segmentId,
    });
  };
  return (
    <Pressable style={[styles.card, { top: insets.top + 54 }]} onPress={openBoard}>
      <Text style={styles.cardLabel} numberOfLines={1}>
        {status.lap > 1 ? `LAP ${status.lap}` : "TRACK TIMED"} -- {status.segmentName}
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
      <View style={styles.cardLinks}>
        <Text style={styles.cardHint}>Tap for the leaderboard</Text>
        <Pressable onPress={shareRun} hitSlop={8}>
          <Text style={styles.cardShare}>SHARE</Text>
        </Pressable>
        {status.driveCount > 1 && (
          <Pressable onPress={showDriveSummary} hitSlop={8}>
            <Text style={styles.cardShare}>THIS DRIVE ({status.driveCount})</Text>
          </Pressable>
        )}
      </View>
      <Pressable style={styles.close} onPress={() => dismissTrackTimerResult()} hitSlop={10}>
        <Text style={styles.closeText}>x</Text>
      </Pressable>
    </Pressable>
  );
}

// "Make this a track?" -- a road you keep driving, your quickest stretch,
// or a track you just drove backwards. Saving it uses this drive as the
// track's first time.
function SuggestCard({ status, top }: { status: Extract<TrackTimerStatus, { kind: "suggest" }>; top: number }) {
  const { units } = useUser();
  const sug = status.suggestion;
  const [name, setName] = useState(sug.name);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const why =
    sug.reason === "reverse"
      ? `You drove ${sug.reverseOfName ?? "a track"} backwards. Save that direction as its own track?`
      : sug.reason === "repeat"
      ? `You've driven this road ${sug.timesDriven} times. Make it a track to race?`
      : "Your quickest stretch of this drive. Make it a track to race?";
  const save = async () => {
    setSaving(true);
    setFailed(false);
    const ok = await saveSuggestedTrack(name);
    if (!ok) {
      setSaving(false);
      setFailed(true);
    }
  };
  return (
    <View style={[styles.card, { top }]}>
      <Text style={styles.cardLabel}>NEW TRACK?</Text>
      <Text style={styles.suggestWhy}>{why}</Text>
      <Text style={styles.cardMetaPlain}>
        {formatDistanceLong(sug.distanceM, units, 1)} -- {formatDuration(sug.durationMs)}
      </Text>
      <TextInput
        style={styles.nameInput}
        value={name}
        onChangeText={setName}
        maxLength={60}
        placeholder="Track name"
        placeholderTextColor={colors.textMuted}
      />
      {failed && <Text style={styles.failed}>Couldn't save it -- try again.</Text>}
      <View style={styles.suggestButtons}>
        <Pressable style={styles.suggestNo} onPress={() => dismissTrackTimerResult()} disabled={saving}>
          <Text style={styles.suggestNoText}>NOT NOW</Text>
        </Pressable>
        <Pressable style={styles.suggestYes} onPress={save} disabled={saving}>
          {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.suggestYesText}>SAVE TRACK</Text>}
        </Pressable>
      </View>
    </View>
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
  cardHint: { color: colors.textMuted, fontSize: 11 },
  cardLinks: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 6 },
  cardShare: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  close: { position: "absolute", top: 6, right: 10 },
  closeText: { color: colors.textSecondary, fontSize: 14, fontWeight: "800" },
  savedName: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 18, marginTop: 6 },
  summaryCard: { alignItems: "stretch", borderColor: colors.cyan },
  summaryHead: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 14, textAlign: "center", marginTop: 4, marginBottom: 8 },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  summaryName: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: "700" },
  summaryTime: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 13 },
  summaryRank: { color: colors.cyan, fontSize: 11, fontWeight: "800", minWidth: 52, textAlign: "right" },
  suggestWhy: { color: colors.textPrimary, fontSize: 14, textAlign: "center", marginTop: 6, lineHeight: 20 },
  cardMetaPlain: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  nameInput: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: colors.panelBorderStrong,
    borderRadius: 4,
    color: colors.textPrimary,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 10,
    fontSize: 14,
  },
  failed: { color: colors.danger, fontSize: 12, marginTop: 6 },
  suggestButtons: { flexDirection: "row", gap: 10, marginTop: 10, alignSelf: "stretch" },
  suggestNo: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 4,
    paddingVertical: 10,
    alignItems: "center",
  },
  suggestNoText: { color: colors.textSecondary, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  suggestYes: { flex: 1, backgroundColor: colors.gold, borderRadius: 4, paddingVertical: 10, alignItems: "center" },
  suggestYesText: { color: colors.bg, fontSize: 12, fontWeight: "900", letterSpacing: 1 },
});
