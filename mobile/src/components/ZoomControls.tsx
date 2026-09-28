import React from "react";
import { View, Text, Pressable, StyleSheet, StyleProp, ViewStyle } from "react-native";
import { colors } from "../theme";

// +/- buttons for the follow camera (see useFollowCamera): closer to read the
// streets, further out to see what's coming. Sits on the right edge of the
// map; pinching works too.
export default function ZoomControls({
  onZoomIn,
  onZoomOut,
  bottom,
  style,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  // Pinned this far from the bottom; otherwise it sits mid-way down.
  bottom?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.wrap, bottom != null ? { bottom } : { top: "46%" }, style]} pointerEvents="box-none">
      <Pressable style={styles.button} onPress={onZoomIn} hitSlop={6} accessibilityLabel="Zoom in">
        <Text style={styles.text}>+</Text>
      </Pressable>
      <View style={styles.divider} />
      <Pressable style={styles.button} onPress={onZoomOut} hitSlop={6} accessibilityLabel="Zoom out">
        <Text style={styles.text}>{"−"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    right: 16,
    width: 42,
    borderRadius: 6,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    overflow: "hidden",
  },
  button: { height: 42, alignItems: "center", justifyContent: "center" },
  divider: { height: 1, backgroundColor: colors.panelBorder },
  text: { color: colors.cyan, fontSize: 22, fontWeight: "700", lineHeight: 24 },
});
