import React from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";
import WelcomeScreen from "../screens/WelcomeScreen";
import DisclaimerScreen from "../screens/DisclaimerScreen";
import UsernameScreen from "../screens/UsernameScreen";
import HomeScreen from "../screens/HomeScreen";
import CreateSegmentScreen from "../screens/CreateSegmentScreen";
import RecordRunScreen from "../screens/RecordRunScreen";
import RunSummaryScreen from "../screens/RunSummaryScreen";
import LeaderboardScreen from "../screens/LeaderboardScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: "#0b0b0f", card: "#0b0b0f" },
};

export default function AppNavigator() {
  const { welcomeSeen, disclaimerAccepted, usernameChosen, user, loading, error, retry } = useUser();

  // Once past welcome + disclaimer, don't let the person wander into
  // screens that silently no-op without a registered user (e.g. Save
  // segment doing nothing) -- show a connecting/retry state instead until
  // the backend registration actually succeeds.
  if (welcomeSeen && disclaimerAccepted && !user) {
    if (loading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color="#ff3b30" size="large" />
          <Text style={styles.connectingText}>Connecting to server...</Text>
        </View>
      );
    }
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Couldn't connect</Text>
        <Text style={styles.errorText}>{error || "Something went wrong reaching the server."}</Text>
        <Pressable style={styles.retryButton} onPress={retry}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  // NOTE: `initialRouteName` is only read once, when the navigator first
  // mounts -- React Navigation does not react to it changing later. So we
  // can't just flip initialRouteName after each gate passes; instead we
  // swap which screens are registered (the standard React Navigation
  // "auth flow" pattern: https://reactnavigation.org/docs/auth-flow/).
  // When the set of screens changes, the navigator automatically resets to
  // the first screen in the new set. Onboarding order: Welcome (what this
  // app is) -> Disclaimer (safety) -> Username (who you race as) -> Home.
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!welcomeSeen ? (
          <Stack.Screen name="Welcome" component={WelcomeScreen} />
        ) : !disclaimerAccepted ? (
          <Stack.Screen name="Disclaimer" component={DisclaimerScreen} />
        ) : !usernameChosen ? (
          <Stack.Screen name="Username" component={UsernameScreen} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="CreateSegment" component={CreateSegmentScreen} />
            <Stack.Screen name="RecordRun" component={RecordRunScreen} />
            <Stack.Screen name="RunSummary" component={RunSummaryScreen} />
            <Stack.Screen
              name="Username"
              component={UsernameScreen}
              options={{ headerShown: true, title: "Change name" }}
            />
            <Stack.Screen
              name="Welcome"
              component={WelcomeScreen}
              options={{ headerShown: true, title: "How it works" }}
            />
            <Stack.Screen
              name="Leaderboard"
              component={LeaderboardScreen}
              options={{ headerShown: true, title: "" }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    backgroundColor: "#0b0b0f",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  connectingText: { color: "#8e8e96", marginTop: 16, fontSize: 14 },
  errorTitle: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 8 },
  errorText: { color: "#8e8e96", fontSize: 14, textAlign: "center", marginBottom: 24 },
  retryButton: {
    backgroundColor: "#ff3b30",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  retryButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
