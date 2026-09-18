import React from "react";
import { View } from "react-native";
import Svg, { Path, Rect, Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { colors } from "../theme";

export type VehicleStyle = "jet" | "arrow" | "bike";

export const VEHICLE_STYLES: { key: VehicleStyle; label: string }[] = [
  { key: "jet", label: "JET" },
  { key: "arrow", label: "ARROW" },
  { key: "bike", label: "LIGHT CYCLE" },
];

type Props = {
  vehicleStyle: VehicleStyle;
  size?: number;
  color?: string;
};

// Top-down silhouettes (nose pointing "up"/north at rest) -- these sit
// inside a react-native-maps <Marker rotation={heading} flat>, so the
// *marker* does the rotating at the native layer; these paths themselves
// never rotate. All three share a 0 0 44 44 viewBox so they drop in
// interchangeably.

// A stylized SR-71 Blackbird from above: needle nose, wide blended
// wing-body chines, a sharp delta sweep, and twin outward-canted tails.
const JET_PATH =
  "M22 2 L25 9 L26 22 L42 36 L28 29 L30 40 L24 33 L22 37 L20 33 L14 40 L16 29 L2 36 L18 22 L19 9 Z";

// A classic concave chevron -- the standard "this way" heading arrow.
const ARROW_PATH = "M22 4 L38 40 L22 30 L6 40 Z";

// A Tron light-cycle, from above: a slim rounded chassis, two axle bars,
// and a glowing racing stripe down the spine standing in for its light
// trail.
const BIKE_BODY_PATH = "M22 4 L27 10 L27 34 L22 40 L17 34 L17 10 Z";

export default function VehicleMarker({ vehicleStyle, size = 40, color = colors.cyan }: Props) {
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 44 44">
        <Defs>
          <RadialGradient id="vehicleGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={22} cy={22} r={21} fill="url(#vehicleGlow)" />
        {vehicleStyle === "jet" && <Path d={JET_PATH} fill={color} stroke={colors.bg} strokeWidth={0.6} />}
        {vehicleStyle === "arrow" && <Path d={ARROW_PATH} fill={color} stroke={colors.bg} strokeWidth={0.6} />}
        {vehicleStyle === "bike" && (
          <>
            <Path d={BIKE_BODY_PATH} fill={color} stroke={colors.bg} strokeWidth={0.6} />
            <Rect x={14} y={11} width={16} height={3} rx={1} fill={color} />
            <Rect x={14} y={30} width={16} height={3} rx={1} fill={color} />
            <Rect x={20.5} y={13} width={3} height={18} rx={1.5} fill={colors.racePrimary} />
          </>
        )}
      </Svg>
    </View>
  );
}
