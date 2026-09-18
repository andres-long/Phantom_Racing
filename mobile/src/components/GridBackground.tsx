import React, { useMemo } from "react";
import { View, StyleSheet, Dimensions } from "react-native";

const { width, height } = Dimensions.get("window");
const SPACING = 32;

// A cheap Tron-style grid floor -- plain Views, no image assets or an SVG
// dependency needed. Sits behind a screen's content as a subtle backdrop.
// Not used on the map screens (Home, RecordRun, CreateSegment), since the
// live map already fills that "digital floor" role there.
export default function GridBackground() {
  const verticals = useMemo(() => Math.ceil(width / SPACING) + 1, []);
  const horizontals = useMemo(() => Math.ceil(height / SPACING) + 1, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: verticals }).map((_, i) => (
        <View key={`v${i}`} style={[styles.vLine, { left: i * SPACING }]} />
      ))}
      {Array.from({ length: horizontals }).map((_, i) => (
        <View key={`h${i}`} style={[styles.hLine, { top: i * SPACING }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  vLine: { position: "absolute", top: 0, bottom: 0, width: 1, backgroundColor: "rgba(44, 232, 245, 0.05)" },
  hLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: "rgba(44, 232, 245, 0.05)" },
});
