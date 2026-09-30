import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, StyleProp, ViewStyle } from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

// Map buttons for the follow camera (see useFollowCamera): a camera that
// switches between close / street / wide views, and a target that puts you
// back in the middle of the map and follows you again. Pinching still works.

export function CameraIcon({ size = 22, color = colors.cyan }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 8.5C3 7.4 3.9 6.5 5 6.5H7.6L9.1 4.5H14.9L16.4 6.5H19C20.1 6.5 21 7.4 21 8.5V17.5C21 18.6 20.1 19.5 19 19.5H5C3.9 19.5 3 18.6 3 17.5V8.5Z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={13} r={3.6} stroke={color} strokeWidth={1.8} />
      <Rect x={17.2} y={8.6} width={1.6} height={1.6} rx={0.4} fill={color} />
    </Svg>
  );
}

export function TargetIcon({ size = 22, color = colors.cyan }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={7} stroke={color} strokeWidth={1.8} />
      <Circle cx={12} cy={12} r={2.4} fill={color} />
      <Line x1={12} y1={1.5} x2={12} y2={5} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={12} y1={19} x2={12} y2={22.5} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={1.5} y1={12} x2={5} y2={12} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={19} y1={12} x2={22.5} y2={12} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

// Switches the view; shows which one it switched to for a moment.
export function CameraButton({
  viewLabel,
  onPress,
  style,
}: {
  viewLabel: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [showLabel, setShowLabel] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const press = () => {
    onPress();
    setShowLabel(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShowLabel(false), 1500);
  };
  return (
    <View style={style}>
      <Pressable style={styles.button} onPress={press} hitSlop={6} accessibilityLabel="Change map view">
        <CameraIcon />
      </Pressable>
      {showLabel && (
        <View style={styles.label} pointerEvents="none">
          <Text style={styles.labelText}>{viewLabel}</Text>
        </View>
      )}
    </View>
  );
}

// Back to you. Lit up while the map has stopped following (you panned away).
export function TargetButton({
  following,
  onPress,
  style,
}: {
  following: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      style={[styles.button, !following && styles.buttonAlert, style]}
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel="Center on me"
    >
      <TargetIcon color={following ? colors.cyan : colors.gold} />
    </Pressable>
  );
}

// A compass needle: cyan tip = north. Lit when the map turns with you.
export function CompassIcon({ size = 22, color = colors.cyan }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9.5} stroke={color} strokeWidth={1.6} opacity={0.6} />
      <Path d="M12 3.8 L15.2 12 L8.8 12 Z" fill={color} />
      <Path d="M12 20.2 L15.2 12 L8.8 12 Z" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </Svg>
  );
}

// Heading-up (the map turns so you always drive up the screen) or
// north-up (the map stays put and your car icon turns).
export function CompassButton({
  mode,
  onPress,
  style,
}: {
  mode: "heading" | "north";
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [showLabel, setShowLabel] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const press = () => {
    onPress();
    setShowLabel(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShowLabel(false), 1500);
  };
  // The label says what it just switched to -- the opposite of before.
  const nowLabel = mode === "heading" ? "HEADING UP" : "NORTH UP";
  return (
    <View style={style}>
      <Pressable
        style={[styles.button, mode === "heading" && styles.buttonLit]}
        onPress={press}
        hitSlop={6}
        accessibilityLabel={mode === "heading" ? "Switch to north up" : "Switch to heading up"}
      >
        <CompassIcon color={mode === "heading" ? colors.cyan : colors.textSecondary} />
      </Pressable>
      {showLabel && (
        <View style={styles.label} pointerEvents="none">
          <Text style={styles.labelText}>{nowLabel}</Text>
        </View>
      )}
    </View>
  );
}

// All three, stacked on the right edge of a driving screen's map.
export default function MapCameraControls({
  viewLabel,
  following,
  onCycleView,
  onRecenter,
  mode,
  onToggleMode,
  bottom,
}: {
  viewLabel: string;
  following: boolean;
  onCycleView: () => void;
  onRecenter: () => void;
  mode: "heading" | "north";
  onToggleMode: () => void;
  // Pinned this far from the bottom; otherwise it sits mid-way down.
  bottom?: number;
}) {
  return (
    <View style={[styles.stack, bottom != null ? { bottom } : { top: "40%" }]} pointerEvents="box-none">
      <CompassButton mode={mode} onPress={onToggleMode} style={{ marginBottom: 10 }} />
      <CameraButton viewLabel={viewLabel} onPress={onCycleView} />
      <TargetButton following={following} onPress={onRecenter} style={{ marginTop: 10 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { position: "absolute", right: 16 },
  button: {
    width: 44,
    height: 44,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonAlert: { borderColor: colors.gold },
  buttonLit: { borderColor: colors.cyan },
  label: {
    position: "absolute",
    right: 52,
    top: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  labelText: { color: colors.cyan, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
});
