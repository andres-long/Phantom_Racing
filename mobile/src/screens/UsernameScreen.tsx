import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Alert, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";
import { colors, fonts, panelStyle } from "../theme";
import GridBackground from "../components/GridBackground";
import NeonButton from "../components/NeonButton";
import VehicleMarker, { VEHICLE_STYLES, VehicleStyle } from "../components/VehicleMarker";

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
      <GridBackground />
      <View style={styles.content}>
        <Text style={styles.title}>{mode === "signup" ? "CREATE YOUR RACER" : "WELCOME BACK"}</Text>
        <Text style={styles.subtitle}>
          {mode === "signup"
            ? "Your name and leaderboard history are tied to this account -- log back in with it on any phone, no need to start over."
            : "Log in with your racer name and password to pick up your leaderboard history here."}
        </Text>
        <TextInput
          style={styles.input}
          placeholder="Racer name"
          placeholderTextColor={colors.textMuted}
          value={name}
          onChangeText={setName}
          maxLength={24}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
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
            placeholderTextColor={colors.textMuted}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        )}
        <NeonButton
          label={submitting ? "PLEASE WAIT..." : mode === "signup" ? "SIGN UP" : "LOG IN"}
          onPress={onSubmit}
          disabled={submitting}
          style={styles.submitButton}
        />
        <NeonButton
          label={mode === "signup" ? "ALREADY HAVE AN ACCOUNT? LOG IN" : "NEW HERE? CREATE AN ACCOUNT"}
          onPress={() => setMode(mode === "signup" ? "login" : "signup")}
          variant="ghost"
          style={styles.switchModeButton}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function AccountView({ navigation }: { navigation: Props["navigation"] }) {
  const { user, setDisplayName, logOut, vehicleStyle, setVehicleStyle } = useUser();
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
      <GridBackground />
      <View style={styles.content}>
        <Text style={styles.title}>CHANGE YOUR NAME</Text>
        <Text style={styles.subtitle}>
          This is what shows up on leaderboards and ghost races, for the multiplayer experience
          -- so other racers know who they're chasing (or being chased by).
        </Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. NightRider"
          placeholderTextColor={colors.textMuted}
          value={name}
          onChangeText={setName}
          maxLength={24}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={onSave}
        />
        <NeonButton
          label={saving ? "SAVING..." : "SAVE"}
          onPress={onSave}
          disabled={saving}
          style={styles.submitButton}
        />

        <Text style={styles.sectionLabel}>MAP MARKER</Text>
        <Text style={styles.subtitle}>What marks your position on the map while you drive.</Text>
        <View style={styles.vehicleRow}>
          {VEHICLE_STYLES.map((v) => {
            const selected = v.key === vehicleStyle;
            return (
              <Pressable
                key={v.key}
                onPress={() => setVehicleStyle(v.key)}
                style={[styles.vehicleOption, selected && styles.vehicleOptionSelected]}
              >
                <VehicleMarker vehicleStyle={v.key} size={40} />
                <Text style={[styles.vehicleLabel, selected && styles.vehicleLabelSelected]}>{v.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <NeonButton label="LOG OUT" onPress={onLogOut} variant="ghost" style={styles.logOutButton} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: 20, justifyContent: "center" },
  title: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 22, letterSpacing: 1.5, marginBottom: 12 },
  subtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 24 },
  input: {
    backgroundColor: colors.panel,
    color: colors.textPrimary,
    padding: 16,
    borderRadius: 4,
    fontSize: 17,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    marginBottom: 16,
  },
  submitButton: { marginTop: 4 },
  switchModeButton: { marginTop: 16 },
  logOutButton: { marginTop: 24 },
  sectionLabel: {
    color: colors.textSecondary,
    fontFamily: fonts.heading,
    fontSize: 12,
    letterSpacing: 1.5,
    marginTop: 28,
    marginBottom: 6,
  },
  vehicleRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  vehicleOption: {
    flex: 1,
    ...panelStyle,
    paddingVertical: 12,
    alignItems: "center",
  },
  vehicleOptionSelected: {
    borderColor: colors.cyan,
    backgroundColor: colors.cyanDim,
  },
  vehicleLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 6,
  },
  vehicleLabelSelected: { color: colors.cyan },
});
