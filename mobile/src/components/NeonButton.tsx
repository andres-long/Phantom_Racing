import React from "react";
import { Pressable, Text, StyleSheet, ViewStyle, StyleProp } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors, fonts, gradients } from "../theme";

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "outline" | "ghost";
  style?: StyleProp<ViewStyle>;
};

// The one CTA button used everywhere: a gradient-filled "primary" (orange
// to magenta, dark text -- reads like a racing badge/brake light) for the
// main action per screen, a cyan-outlined "outline" for secondary actions,
// and a plain "ghost" for the quietest actions (log out, etc). Centralized
// so all nine screens' buttons read consistently instead of each one
// styling its own.
export default function NeonButton({ label, onPress, disabled, variant = "primary", style }: Props) {
  if (variant === "outline") {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={[styles.outline, style, disabled && styles.disabled]}
      >
        <Text style={styles.outlineText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {label}
        </Text>
      </Pressable>
    );
  }

  if (variant === "ghost") {
    return (
      <Pressable onPress={onPress} disabled={disabled} style={[styles.ghost, style, disabled && styles.disabled]}>
        <Text style={styles.ghostText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.wrap, style, disabled && styles.disabled]}>
      <LinearGradient colors={gradients.race} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.gradient}>
        <Text style={styles.primaryText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {label}
        </Text>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 8, overflow: "hidden" },
  gradient: { paddingVertical: 16, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#05070c", fontFamily: fonts.heading, fontSize: 15, letterSpacing: 1, textAlign: "center" },
  outline: {
    borderWidth: 1.5,
    borderColor: colors.cyan,
    borderRadius: 8,
    paddingVertical: 15,
    paddingHorizontal: 6,
    alignItems: "center",
    backgroundColor: colors.cyanDim,
  },
  outlineText: {
    color: colors.cyan,
    fontFamily: fonts.heading,
    fontSize: 13,
    letterSpacing: 0.5,
    textAlign: "center",
  },
  ghost: { paddingVertical: 10, alignItems: "center" },
  ghostText: {
    color: colors.textSecondary,
    fontFamily: fonts.label,
    fontSize: 12,
    letterSpacing: 1,
    textAlign: "center",
  },
  disabled: { opacity: 0.45 },
});
