import React, { useState } from "react";
import { View, StyleSheet, LayoutChangeEvent } from "react-native";
import Svg, { Path, Circle, Line, Text as SvgText, G, Defs, RadialGradient, Stop } from "react-native-svg";
import { colors } from "../theme";

// Turns a full-screen map into an NFS-style round minimap: everything
// outside a circle in the middle of the screen goes dark, with a glowing
// ring, tick marks, and an N that swings round the ring as the map turns.
// Lay it right after the <MapView> (same frame), so the circle sits exactly
// where the follow camera keeps you -- the middle of the map.
export default function MinimapFrame({
  headingDeg = 0,
  accent = colors.cyan,
  // Circle size as a share of the screen's width (capped by its height).
  sizeRatio = 0.82,
  // Nudge the circle up/down (screen points) -- 0 keeps it on you.
  offsetY = 0,
}: {
  headingDeg?: number;
  accent?: string;
  sizeRatio?: number;
  offsetY?: number;
}) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const { w, h } = box;
  const r = Math.min(w * sizeRatio, h * 0.62) / 2;
  const cx = w / 2;
  const cy = h / 2 + offsetY;

  // The dark surround: the whole screen with the circle cut out of it.
  const mask =
    `M0,0 H${w} V${h} H0 Z ` +
    `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`;

  // North on the ring: straight up when the map is north-up, otherwise
  // swung round by the way you're heading.
  const nAngle = ((-headingDeg - 90) * Math.PI) / 180;
  const nx = cx + Math.cos(nAngle) * (r + 16);
  const ny = cy + Math.sin(nAngle) * (r + 16);

  const ticks = [];
  for (let i = 0; i < 72; i++) {
    const a = (i * 5 * Math.PI) / 180;
    const major = i % 9 === 0;
    const r1 = r + 4;
    const r2 = r + (major ? 12 : 7);
    ticks.push(
      <Line
        key={i}
        x1={cx + Math.cos(a) * r1}
        y1={cy + Math.sin(a) * r1}
        x2={cx + Math.cos(a) * r2}
        y2={cy + Math.sin(a) * r2}
        stroke={accent}
        strokeOpacity={major ? 0.8 : 0.3}
        strokeWidth={major ? 2 : 1}
      />
    );
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={onLayout}>
      {w > 0 && (
        <Svg width={w} height={h}>
          <Defs>
            <RadialGradient id="vignette" cx={cx} cy={cy} r={r} gradientUnits="userSpaceOnUse">
              <Stop offset="0.72" stopColor="#000" stopOpacity="0" />
              <Stop offset="1" stopColor="#000" stopOpacity="0.55" />
            </RadialGradient>
          </Defs>
          <Path d={mask} fill={colors.bg} fillRule="evenodd" fillOpacity={0.96} />
          {/* Darker towards the rim, like a scope. */}
          <Circle cx={cx} cy={cy} r={r} fill="url(#vignette)" />
          {/* Range rings. */}
          <Circle cx={cx} cy={cy} r={r * 0.5} stroke={accent} strokeOpacity={0.18} strokeWidth={1} fill="none" />
          <Line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={accent} strokeOpacity={0.1} strokeWidth={1} />
          <Line x1={cx} y1={cy - r} x2={cx} y2={cy + r} stroke={accent} strokeOpacity={0.1} strokeWidth={1} />
          {/* The glowing rim: a soft wide stroke under a crisp one. */}
          <Circle cx={cx} cy={cy} r={r} stroke={accent} strokeOpacity={0.18} strokeWidth={12} fill="none" />
          <Circle cx={cx} cy={cy} r={r} stroke={accent} strokeOpacity={0.35} strokeWidth={6} fill="none" />
          <Circle cx={cx} cy={cy} r={r} stroke={accent} strokeWidth={2.5} fill="none" />
          <G>{ticks}</G>
          <Circle cx={nx} cy={ny} r={11} fill={colors.bg} stroke={colors.racePrimary} strokeWidth={2} />
          <SvgText
            x={nx}
            y={ny + 4.5}
            fill={colors.racePrimary}
            fontSize={13}
            fontWeight="900"
            textAnchor="middle"
          >
            N
          </SvgText>
        </Svg>
      )}
    </View>
  );
}
