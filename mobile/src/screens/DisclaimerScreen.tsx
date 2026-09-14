import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useUser } from "../context/UserContext";

// First-launch gate. This app is intentionally "ghost racing" (you vs.
// recorded times on a road you already drive), not live head-to-head racing
// against strangers in real time -- see the project README for why. This
// screen exists to make that framing explicit to every user, not just bury
// it in a terms-of-service nobody reads.
export default function DisclaimerScreen() {
  const { acceptDisclaimer } = useUser();

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Before you race</Text>
        <Text style={styles.paragraph}>
          This app times you against your own or other drivers' recorded runs on stretches of
          road ("segments") -- like a leaderboard, not a live race. You never share the road at
          the same moment as your "opponent."
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
      <Pressable style={styles.button} onPress={acceptDisclaimer}>
        <Text style={styles.buttonText}>I understand -- let's go</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f", padding: 20, justifyContent: "space-between" },
  scroll: { paddingTop: 60, paddingBottom: 20 },
  title: { color: "#fff", fontSize: 28, fontWeight: "700", marginBottom: 16 },
  paragraph: { color: "#c7c7cf", fontSize: 15, lineHeight: 22, marginBottom: 16 },
  button: { backgroundColor: "#ff3b30", borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 20 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
