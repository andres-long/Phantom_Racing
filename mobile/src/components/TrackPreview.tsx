import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { LatLng } from "../types";
import { toLocalXY, resamplePolyline } from "../utils/geo";
import { colors } from "../theme";

type Props = {
  points: LatLng[];
  height?: number;
  color?: string;
};

// A cheap route-shape thumbnail drawn with plain Views (no map tiles, no
// react-native-svg dependency -- same trick as GridBackground) so it costs
// nothing to render dozens of these in a scrolling list. The actual line is
// a chain of thin rotated Views between resampled points; a cyan dot marks
// the start, a gold dot the finish, same color language as the ghost
// marker and record color used elsewhere.
export default function TrackPreview({ points, height = 64, color = colors.cyan }: Props) {
  const [width, setWidth] = useState(0);

  const renderRoute = () => {
    if (points.length < 2 || width === 0) return null;

    const sampled = resamplePolyline(points, 24);
    const xy = toLocalXY(sampled);
    const xs = xy.map((p) => p.x);
    const ys = xy.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);

    const pad = 10;
    const drawW = width - pad * 2;
    const drawH = height - pad * 2;
    const scale = Math.min(drawW / spanX, drawH / spanY);
    const offsetX = (drawW - spanX * scale) / 2;
    const offsetY = (drawH - spanY * scale) / 2;

    // North is "up": local y grows northward, screen y grows downward.
    const screen = xy.map((p) => ({
      x: pad + offsetX + (p.x - minX) * scale,
      y: height - pad - offsetY - (p.y - minY) * scale,
    }));

    const segments = [];
    for (let i = 0; i < screen.length - 1; i++) {
      const a = screen[i];
      const b = screen[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;
      const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      segments.push(
        <View
          key={i}
          style={{
            position: "absolute",
            left: midX - len / 2,
            top: midY - 1,
            width: len,
            height: 2,
            borderRadius: 1,
            backgroundColor: color,
            transform: [{ rotate: `${angleDeg}deg` }],
          }}
        />
      );
    }

    const start = screen[0];
    const end = screen[screen.length - 1];

    return (
      <>
        {segments}
        <View style={[styles.dot, styles.startDot, { left: start.x - 3, top: start.y - 3 }]} />
        <View style={[styles.dot, styles.endDot, { left: end.x - 3, top: end.y - 3 }]} />
      </>
    );
  };

  return (
    <View
      style={[styles.wrap, { height }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {points.length < 2 ? (
        <Text style={styles.emptyText}>No route recorded</Text>
      ) : (
        renderRoute()
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bgElevated,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.divider,
    overflow: "hidden",
    marginBottom: 10,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginTop: 22,
  },
  dot: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  startDot: { backgroundColor: colors.cyan },
  endDot: { backgroundColor: colors.gold },
});
