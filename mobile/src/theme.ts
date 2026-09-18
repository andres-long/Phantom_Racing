// Shared visual language for the whole app: a Tron-Legacy-meets-Need-for-
// Speed dashboard -- near-black backgrounds, glowing cyan grid lines and
// hairline borders, and a hot orange-to-magenta gradient for anything you'd
// tap or that means "go" or "new record". Centralizing colors, fonts, and a
// few reusable style shapes here keeps all nine screens consistent, and
// makes a future palette tweak a one-file change instead of a hunt through
// every screen.

export const colors = {
  bg: "#05070c",
  bgElevated: "#0b0f17",
  panel: "#0d131ce6",
  panelBorder: "rgba(56, 232, 245, 0.28)",
  panelBorderStrong: "rgba(56, 232, 245, 0.55)",
  cyan: "#2ce8f5",
  cyanDim: "rgba(44, 232, 245, 0.14)",
  blue: "#4d7dff",
  racePrimary: "#ff5023",
  raceSecondary: "#ff2d6a",
  racePrimaryDim: "rgba(255, 80, 35, 0.16)",
  gold: "#ffcf3d",
  danger: "#ff5470",
  textPrimary: "#eef6ff",
  textSecondary: "#7d93ab",
  textMuted: "#526279",
  divider: "rgba(56, 232, 245, 0.16)",
};

export const gradients = {
  race: [colors.racePrimary, colors.raceSecondary] as [string, string],
  cyanFade: [colors.cyan, colors.blue] as [string, string],
};

// Orbitron is a geometric/technical display font -- used for headings,
// buttons, badges, and HUD numbers (speed, time, rank) for that sci-fi
// dashboard read. Body paragraphs stay on the system font since a display
// font like this hurts readability at length; see App.tsx for where these
// weights get loaded.
export const fonts = {
  display: "Orbitron_900Black",
  heading: "Orbitron_700Bold",
  label: "Orbitron_500Medium",
};

// A HUD-style panel: dark glass with a glowing cyan hairline border and
// squared-off corners (4px, not the old friendly 14-16px) -- used for every
// floating card/HUD across the app instead of each screen inventing its
// own panel style.
export const panelStyle = {
  backgroundColor: colors.panel,
  borderWidth: 1,
  borderColor: colors.panelBorder,
  borderRadius: 4,
};

// A colored glow behind text/icons/panels. Only iOS actually renders a
// colored shadow (Android ignores shadowColor on plain Views and falls
// back to a grey elevation shadow) -- harmless there, and the saturated
// border color on the element itself carries the "glow" look on both
// platforms regardless.
export const glow = (color: string, radius = 10) => ({
  shadowColor: color,
  shadowOpacity: 0.9,
  shadowRadius: radius,
  shadowOffset: { width: 0, height: 0 },
  elevation: 6,
});
