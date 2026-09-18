import React from "react";
import { View, StyleSheet, ActivityIndicator } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";
import WelcomeScreen from "../screens/WelcomeScreen";
import DisclaimerScreen from "../screens/DisclaimerScreen";
import UsernameScreen from "../screens/UsernameScreen";
import HomeScreen from "../screens/HomeScreen";
import AllSegmentsScreen from "../screens/AllSegmentsScreen";
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
  const { welcomeSeen, disclaimerAccepted, user, loading } = useUser();

  // Brief check of AsyncStorage for a saved account on cold start -- not a
  // network call, so this is normally sub-second.
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#ff3b30" size="large" />
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
  // app is) -> Disclaimer (safety) -> Username (sign up / log in) -> Home.
  // Logging out drops `user` back to null, which sends you right back to
  // the Username screen (in its sign-up/log-in mode) the same way.
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!welcomeSeen ? (
          <Stack.Screen name="Welcome" component={WelcomeScreen} />
        ) : !disclaimerAccepted ? (
          <Stack.Screen name="Disclaimer" component={DisclaimerScreen} />
        ) : !user ? (
          <Stack.Screen name="Username" component={UsernameScreen} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen
              name="AllSegments"
              component={AllSegmentsScreen}
              options={{ headerShown: true, title: "All tracks" }}
            />
            <Stack.Screen name="CreateSegment" component={CreateSegmentScreen} />
            <Stack.Screen name="RecordRun" component={RecordRunScreen} />
            <Stack.Screen name="RunSummary" component={RunSummaryScreen} />
            <Stack.Screen
              name="Username"
              component={UsernameScreen}
              options={{ headerShown: true, title: "Account" }}
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
});
