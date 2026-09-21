import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
  Switch,
  ScrollView,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RootStackParamList, BlockedPlayer } from "../types";
import { api } from "../api/client";
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
            ? "Your name and leaderboard history are tied to this account."
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

const UNIT_OPTIONS: { key: "metric" | "imperial"; label: string }[] = [
  { key: "metric", label: "KM/H" },
  { key: "imperial", label: "MPH" },
];

function AccountView({ navigation }: { navigation: Props["navigation"] }) {
  const {
    user,
    setDisplayName,
    logOut,
    vehicleStyle,
    setVehicleStyle,
    incognito,
    setIncognito,
    voiceEnabled,
    setVoiceEnabled,
    units,
    setUnits,
  } = useUser();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(user?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [blockedPlayers, setBlockedPlayers] = useState<BlockedPlayer[]>([]);

  const loadBlocked = async () => {
    if (!user) return;
    try {
      const { blocked } = await api.getBlockedPlayers(user.deviceId);
      setBlockedPlayers(blocked);
    } catch {
      // Best-effort -- the list just stays whatever it last was.
    }
  };

  useEffect(() => {
    loadBlocked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.deviceId]);

  const onUnblock = async (p: BlockedPlayer) => {
    if (!user) return;
    // Optimistic -- unblocking has no real failure mode worth blocking the
    // UI on, and a failed request just means they reappear on the next
    // load.
    setBlockedPlayers((prev) => prev.filter((b) => b.deviceId !== p.deviceId));
    try {
      await api.unblockPlayer(user.deviceId, p.deviceId);
    } catch {
      loadBlocked();
    }
  };

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
      {/* Its own content style, not styles.content: that one's flex:1 +
          justifyContent:center pinned the content to exactly one screen of
          height (so it couldn't scroll) and centered the overflow, pushing
          the name field up under the header where it got cut off. */}
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.signedInLabel}>SIGNED IN AS</Text>
        <Text style={styles.currentName}>{user?.displayName}</Text>

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

        <Text style={styles.sectionLabel}>UNITS</Text>
        <Text style={styles.subtitle}>Speed and distance everywhere in the app -- HUDs, leaderboards, stats.</Text>
        <View style={styles.vehicleRow}>
          {UNIT_OPTIONS.map((o) => {
            const selected = o.key === units;
            return (
              <Pressable
                key={o.key}
                onPress={() => setUnits(o.key)}
                style={[styles.vehicleOption, selected && styles.vehicleOptionSelected]}
              >
                <Text style={[styles.unitOptionText, selected && styles.vehicleLabelSelected]}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>LIVE LOCATION</Text>
        <Text style={styles.subtitle}>
          While this is on, other racers can see your username and live position on the map
          whenever you have the app open. Turn on incognito to hide yourself -- you'll still see
          everyone else.
        </Text>
        <View style={styles.incognitoRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.incognitoLabel}>Incognito mode</Text>
            <Text style={styles.incognitoHint}>
              {incognito ? "You're hidden from other racers right now." : "Your position is visible to other racers."}
            </Text>
          </View>
          <Switch
            value={incognito}
            onValueChange={setIncognito}
            trackColor={{ false: colors.panelBorder, true: colors.racePrimaryDim }}
            thumbColor={incognito ? colors.racePrimary : colors.textMuted}
            ios_backgroundColor={colors.panelBorder}
          />
        </View>

        <Text style={styles.sectionLabel}>PROXIMITY VOICE</Text>
        <Text style={styles.subtitle}>
          Push-to-talk audio with whoever's nearby and not blocked. Turn this off to go completely
          silent -- you won't hear anyone nearby, and they won't hear you either.
        </Text>
        <View style={styles.incognitoRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.incognitoLabel}>Proximity audio</Text>
            <Text style={styles.incognitoHint}>
              {voiceEnabled ? "Nearby racers can voice-chat with you." : "You're not reachable for proximity voice."}
            </Text>
          </View>
          <Switch
            value={voiceEnabled}
            onValueChange={setVoiceEnabled}
            trackColor={{ false: colors.panelBorder, true: colors.racePrimaryDim }}
            thumbColor={voiceEnabled ? colors.racePrimary : colors.textMuted}
            ios_backgroundColor={colors.panelBorder}
          />
        </View>

        {blockedPlayers.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>BLOCKED PLAYERS</Text>
            <Text style={styles.subtitle}>They can't voice-chat with you, and you won't show up for them either.</Text>
            {blockedPlayers.map((p) => (
              <View key={p.deviceId} style={styles.blockedRow}>
                <Text style={styles.blockedName} numberOfLines={1}>
                  {p.displayName}
                </Text>
                <Pressable onPress={() => onUnblock(p)} style={styles.unblockButton} hitSlop={6}>
                  <Text style={styles.unblockButtonText}>UNBLOCK</Text>
                </Pressable>
              </View>
            ))}
          </>
        )}

        <NeonButton label="LOG OUT" onPress={onLogOut} variant="ghost" style={styles.logOutButton} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: 20, justifyContent: "center" },
  scrollContent: { flexGrow: 1, padding: 20, paddingTop: 24 },
  signedInLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  currentName: {
    color: colors.cyan,
    fontFamily: fonts.display,
    fontSize: 24,
    marginTop: 4,
    marginBottom: 28,
  },
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
  unitOptionText: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 13, letterSpacing: 1 },
  incognitoRow: {
    ...panelStyle,
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    marginTop: 4,
  },
  incognitoLabel: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  incognitoHint: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  blockedRow: {
    ...panelStyle,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginTop: 8,
  },
  blockedName: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: "600", paddingRight: 10 },
  unblockButton: {
    borderWidth: 1.5,
    borderColor: colors.cyan,
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  unblockButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
});
