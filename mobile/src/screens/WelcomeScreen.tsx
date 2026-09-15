import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";

type Props = NativeStackScreenProps<RootStackParamList, "Welcome">;

// The very first screen a new user sees, explaining the concept and the
// basic loop before they're dropped into the app -- also reachable later
// from Home's header ("How it works") as a normal revisit. Kept short and
// scannable; a wall of text here just gets skipped past.
export default function WelcomeScreen({ navigation }: Props) {
  const { welcomeSeen, completeWelcome } = useUser();
  // First launch: this screen gates the whole app, so "continue" means
  // marking welcome as seen and letting the navigator swap to the next
  // gate. Revisit from Home: it's just a normal pushed screen, so
  // "continue" means going back to where they came from.
  const isFirstLaunch = !welcomeSeen;

  const onContinue = async () => {
    if (isFirstLaunch) {
      await completeWelcome();
    } else {
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate("Home");
      }
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Phantom Racing</Text>
        <Text style={styles.tagline}>Need for Speed, but it's the road you actually drive.</Text>

        <View style={styles.step}>
          <Text style={styles.stepNumber}>1</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>Record a segment</Text>
            <Text style={styles.stepText}>
              Drive (or walk) a stretch of road once with "New segment". That drive becomes a
              segment other people can race -- and it's automatically your first time on the
              leaderboard, no need to drive it twice.
            </Text>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={styles.stepNumber}>2</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>Race a "ghost"</Text>
            <Text style={styles.stepText}>
              Pick any segment and hit "Race it". You're timed against the current best run
              live, shown as a ghost marker on the map -- ahead or behind, in real time.
            </Text>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={styles.stepNumber}>3</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>Climb the leaderboard</Text>
            <Text style={styles.stepText}>
              Every run is ranked by time. Beat the leader and you set the new ghost everyone
              else races next.
            </Text>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={styles.stepWarn}>!</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>This isn't a live race</Text>
            <Text style={styles.stepText}>
              You never share the road with your "opponent" at the same moment -- you're racing
              a recorded time, not another car next to you. Obey traffic laws and speed limits
              always, and never touch your phone while driving.
            </Text>
          </View>
        </View>
      </ScrollView>
      <Pressable style={styles.button} onPress={onContinue}>
        <Text style={styles.buttonText}>{isFirstLaunch ? "Let's go" : "Got it"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f", padding: 20, justifyContent: "space-between" },
  scroll: { paddingTop: 60, paddingBottom: 20 },
  title: { color: "#fff", fontSize: 30, fontWeight: "800" },
  tagline: { color: "#8e8e96", fontSize: 15, marginTop: 6, marginBottom: 28 },
  step: { flexDirection: "row", marginBottom: 22 },
  stepNumber: {
    color: "#ff3b30",
    fontSize: 15,
    fontWeight: "800",
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#ff3b30",
    textAlign: "center",
    lineHeight: 25,
    marginRight: 14,
    overflow: "hidden",
  },
  stepWarn: {
    color: "#ffd60a",
    fontSize: 15,
    fontWeight: "800",
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#ffd60a",
    textAlign: "center",
    lineHeight: 25,
    marginRight: 14,
    overflow: "hidden",
  },
  stepBody: { flex: 1 },
  stepTitle: { color: "#fff", fontSize: 16, fontWeight: "700", marginBottom: 4 },
  stepText: { color: "#c7c7cf", fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: "#ff3b30", borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 20 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
