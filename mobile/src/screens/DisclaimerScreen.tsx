import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { useUser } from "../context/UserContext";
import { colors, fonts } from "../theme";
import GridBackground from "../components/GridBackground";
import NeonButton from "../components/NeonButton";

// First-launch gate. The core mode is "ghost racing" (you vs. recorded
// times on a road you already drive); nearby players can also challenge
// each other to a live head-to-head race, timed the same way -- first to
// cover the chosen distance. This screen exists to make the safety framing
// explicit to every user either way, not just bury it in a terms-of-service
// nobody reads.
export default function DisclaimerScreen() {
  const { acceptDisclaimer } = useUser();

  return (
    <View style={styles.container}>
      <GridBackground />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>BEFORE YOU RACE</Text>
        <Text style={styles.paragraph}>
          This app times you against your own or other drivers' recorded runs on stretches of
          road ("segments") -- like a leaderboard. If another racer is nearby and online, you can
          also challenge them directly to a live race, so you may share the road with your
          opponent at the same time -- treat that exactly like any other traffic around you.
        </Text>
        <Text style={styles.paragraph}>
          Obey all traffic laws and speed limits at all times. Never look at your phone while
          driving -- mount it, use voice/audio cues, or have a passenger watch it. Your safety
          and everyone else's on the road comes first, always. This app will never ask you to
          exceed the speed limit or drive recklessly to get a better time.
        </Text>
        <Text style={styles.paragraph}>
          Recorded segments and leaderboards should be public roads you'd drive anyway, or
          better yet, closed courses and legal track/autocross events.
        </Text>
      </ScrollView>
      <NeonButton label="I UNDERSTAND -- LET'S GO" onPress={acceptDisclaimer} style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 20, justifyContent: "space-between" },
  scroll: { paddingTop: 60, paddingBottom: 20 },
  title: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 22, letterSpacing: 1.5, marginBottom: 18 },
  paragraph: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 16 },
  button: { marginBottom: 20 },
});
