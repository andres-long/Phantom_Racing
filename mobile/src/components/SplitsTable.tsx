import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { formatDuration } from "../utils/geo";
import { colors, fonts } from "../theme";

// A run's checkpoint splits: each quarter of the track, the time through it,
// and the track's record for that quarter -- gold where this run set it.
export const CHECKPOINT_NAMES = ["1ST QUARTER", "2ND QUARTER", "3RD QUARTER", "4TH QUARTER"];

export default function SplitsTable({
  splitsMs,
  sectorsMs,
  sectorRecordsMs,
  sectorIsRecord,
}: {
  splitsMs: number[];
  sectorsMs: number[];
  sectorRecordsMs?: (number | null)[];
  sectorIsRecord?: boolean[];
}) {
  return (
    <View style={styles.table}>
      <View style={styles.row}>
        <Text style={[styles.head, styles.nameCol]}>CHECKPOINT</Text>
        <Text style={styles.head}>SECTOR</Text>
        <Text style={styles.head}>RECORD</Text>
        <Text style={styles.head}>AT</Text>
      </View>
      {sectorsMs.map((ms, i) => {
        const isRecord = !!sectorIsRecord?.[i];
        const rec = sectorRecordsMs?.[i] ?? null;
        return (
          <View key={i} style={styles.row}>
            <Text style={[styles.cell, styles.nameCol]}>{CHECKPOINT_NAMES[i] ?? `CP ${i + 1}`}</Text>
            <Text style={[styles.cell, isRecord && styles.record]}>{formatDuration(ms)}</Text>
            <Text style={styles.cellMuted}>
              {isRecord ? "NEW" : rec != null ? `${formatDuration(rec)}` : "--"}
            </Text>
            <Text style={styles.cellMuted}>{formatDuration(splitsMs[i] ?? 0)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  table: { alignSelf: "stretch", marginTop: 14 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.divider },
  nameCol: { flex: 1.4, textAlign: "left" },
  head: { flex: 1, color: colors.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 1, textAlign: "right" },
  cell: { flex: 1, color: colors.textPrimary, fontSize: 13, fontFamily: fonts.heading, textAlign: "right" },
  cellMuted: { flex: 1, color: colors.textSecondary, fontSize: 12, textAlign: "right" },
  record: { color: colors.gold },
});
