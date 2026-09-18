import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, Alert } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";

type Props = NativeStackScreenProps<RootStackParamList, "Username">;

// Two very different jobs share this one screen, split by whether you're
// already signed in. Not signed in (first launch, or after logging out):
// sign up or log in with a name + password, so your name and leaderboard
// history follow you to a new phone or a fresh install instead of being
// stuck on one device forever. Already signed in (reached from Home's
// header): rename, or log out.
export default function UsernameScreen({ navigation }: Props) {
  const { user } = useUser();
  return user ? <AccountView navigation={navigation} /> : <AuthForm />;
}

function AuthForm() {
  const { register, login } = useUser();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Pick a name", "Other racers will see this on the leaderboard.");
      return;
    }
    if (password.length < 4) {
      Alert.alert("Password too short", "Use at least 4 characters.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      Alert.alert("Passwords don't match", "Double-check both password fields.");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "signup") {
        await register(trimmed, password);
      } else {
        await login(trimmed, password);
      }
    } catch (e: any) {
      Alert.alert(mode === "signup" ? "Couldn't sign up" : "Couldn't log in", e.message || "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
        <Text style={styles.title}>{mode === "signup" ? "Create your racer account" : "Welcome back"}</Text>
        <Text style={styles.subtitle}>
          {mode === "signup"
            ? "Your name and leaderboard history are tied to this account -- log back in with it on any phone, no need to start over."
            : "Log in with your racer name and password to pick up your leaderboard history here."}
        </Text>
        <TextInput
          style={styles.input}
          placeholder="Racer name"
          placeholderTextColor="#8e8e96"
          value={name}
          onChangeText={setName}
          maxLength={24}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#8e8e96"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          returnKeyType={mode === "signup" ? "next" : "done"}
          onSubmitEditing={mode === "login" ? onSubmit : undefined}
        />
        {mode === "signup" && (
          <TextInput
            style={styles.input}
            placeholder="Confirm password"
            placeholderTextColor="#8e8e96"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        )}
        <Pressable style={styles.button} onPress={onSubmit} disabled={submitting}>
          <Text style={styles.buttonText}>
            {submitting ? "Please wait..." : mode === "signup" ? "Sign up" : "Log in"}
          </Text>
        </Pressable>
        <Pressable
          style={styles.switchModeButton}
          onPress={() => setMode(mode === "signup" ? "login" : "signup")}
        >
          <Text style={styles.switchModeText}>
            {mode === "signup" ? "Already have an account? Log in" : "New here? Create an account"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function AccountView({ navigation }: { navigation: Props["navigation"] }) {
  const { user, setDisplayName, logOut } = useUser();
  const [name, setName] = useState(user?.displayName ?? "");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Pick a name", "Other racers will see this on the leaderboard.");
      return;
    }
    setSaving(true);
    try {
      await setDisplayName(trimmed);
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate("Home");
      }
    } catch (e: any) {
      Alert.alert("Couldn't save name", e.message || "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const onLogOut = () => {
    Alert.alert("Log out?", "You'll need your password to log back in on this device.", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => logOut() },
    ]);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
        <Text style={styles.title}>Change your name</Text>
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
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={onSave}
        />
        <Pressable style={styles.button} onPress={onSave} disabled={saving}>
          <Text style={styles.buttonText}>{saving ? "Saving..." : "Save"}</Text>
        </Pressable>
        <Pressable style={styles.logOutButton} onPress={onLogOut}>
          <Text style={styles.logOutText}>Log out</Text>
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
  switchModeButton: { marginTop: 20, alignItems: "center" },
  switchModeText: { color: "#8e8e96", fontSize: 14, fontWeight: "600" },
  logOutButton: { marginTop: 16, alignItems: "center", paddingVertical: 10 },
  logOutText: { color: "#ff6b6b", fontSize: 14, fontWeight: "700" },
});
