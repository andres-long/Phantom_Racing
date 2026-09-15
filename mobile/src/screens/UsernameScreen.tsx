import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, Alert } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";

type Props = NativeStackScreenProps<RootStackParamList, "Username">;

// Reached two ways: first launch, gating the whole app until a name is
// chosen (usernameChosen === false), or later from Home's header to
// rename -- a normal pushed screen with a back button. Same form either
// way; only what happens after Save differs.
export default function UsernameScreen({ navigation }: Props) {
  const { user, usernameChosen, completeUsername, setDisplayName } = useUser();
  const isFirstLaunch = !usernameChosen;
  const [name, setName] = useState(user && user.displayName !== "Racer" ? user.displayName : "");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Pick a name", "Other racers will see this on the leaderboard.");
      return;
    }
    setSaving(true);
    try {
      if (isFirstLaunch) {
        await completeUsername(trimmed);
      } else {
        await setDisplayName(trimmed);
        if (navigation.canGoBack()) {
          navigation.goBack();
        } else {
          navigation.navigate("Home");
        }
      }
    } catch (e: any) {
      Alert.alert("Couldn't save name", e.message || "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
        <Text style={styles.title}>{isFirstLaunch ? "Pick a racer name" : "Change your name"}</Text>
        <Text style={styles.subtitle}>
          This is what shows up on leaderboards and ghost races, for the multiplayer experience
          -- so other racers know who they're chasing (or being chased by).
        </Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. NightRider"
          placeholderTextColor="#8e8e96"
          value={name}
          onChangeText={setName}
          maxLength={24}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={onSave}
        />
        <Pressable style={styles.button} onPress={onSave} disabled={saving}>
          <Text style={styles.buttonText}>{saving ? "Saving..." : "Save"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  content: { flex: 1, padding: 20, justifyContent: "center" },
  title: { color: "#fff", fontSize: 26, fontWeight: "800", marginBottom: 10 },
  subtitle: { color: "#8e8e96", fontSize: 14, lineHeight: 20, marginBottom: 24 },
  input: {
    backgroundColor: "#17171d",
    color: "#fff",
    padding: 16,
    borderRadius: 12,
    fontSize: 18,
    borderWidth: 1,
    borderColor: "#33333d",
    marginBottom: 16,
  },
  button: { backgroundColor: "#ff3b30", borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
