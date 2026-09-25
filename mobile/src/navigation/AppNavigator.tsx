import React from "react";
import { View, StyleSheet, ActivityIndicator } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";
import { ProximityVoiceProvider } from "../context/ProximityVoiceContext";
import { colors, fonts } from "../theme";
import WelcomeScreen from "../screens/WelcomeScreen";
import DisclaimerScreen from "../screens/DisclaimerScreen";
import UsernameScreen from "../screens/UsernameScreen";
import HomeScreen from "../screens/HomeScreen";
import AllSegmentsScreen from "../screens/AllSegmentsScreen";
import CreateSegmentScreen from "../screens/CreateSegmentScreen";
import RecordRunScreen from "../screens/RecordRunScreen";
import RunSummaryScreen from "../screens/RunSummaryScreen";
import LeaderboardScreen from "../screens/LeaderboardScreen";
import GoToScreen from "../screens/GoToScreen";
import GoRaceScreen from "../screens/GoRaceScreen";
import GoSummaryScreen from "../screens/GoSummaryScreen";
import StatsScreen from "../screens/StatsScreen";
import RaceLiveScreen from "../screens/RaceLiveScreen";
import RaceResultScreen from "../screens/RaceResultScreen";
import SoloRunScreen from "../screens/SoloRunScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bgElevated, primary: colors.cyan },
};

// Shared look for the handful of screens that use a native header bar
// (AllSegments, Username, Welcome-as-revisit, Leaderboard) -- dark glass
// bar, cyan back-button/title tint, Orbitron title text, and a glowing
// cyan hairline instead of the default header shadow.
const headerOptions = {
  headerStyle: { backgroundColor: colors.bgElevated },
  headerTintColor: colors.cyan,
  headerTitleStyle: { fontFamily: fonts.heading, fontSize: 15, color: colors.textPrimary, letterSpacing: 1 },
  headerShadowVisible: false,
} as const;

export default function AppNavigator() {
  const { welcomeSeen, disclaimerAccepted, user, loading } = useUser();

  // Brief check of AsyncStorage for a saved account on cold start -- not a
  // network call, so this is normally sub-second.
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.cyan} size="large" />
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
    // Above the navigator, not inside any one screen -- see
    // ProximityVoiceContext.tsx for why this has to be a single instance
    // shared app-wide rather than something each screen sets up itself. It
    // no-ops (no mic, no connections) until a user is actually signed in.
    <ProximityVoiceProvider>
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
              options={{ ...headerOptions, headerShown: true, title: "ALL TRACKS" }}
            />
            <Stack.Screen name="CreateSegment" component={CreateSegmentScreen} />
            <Stack.Screen name="RecordRun" component={RecordRunScreen} />
            <Stack.Screen name="RunSummary" component={RunSummaryScreen} />
            <Stack.Screen name="GoTo" component={GoToScreen} />
            <Stack.Screen name="GoRace" component={GoRaceScreen} />
            <Stack.Screen name="GoSummary" component={GoSummaryScreen} />
            <Stack.Screen
              name="Username"
              component={UsernameScreen}
              options={{ ...headerOptions, headerShown: true, title: "ACCOUNT" }}
            />
            <Stack.Screen
              name="Welcome"
              component={WelcomeScreen}
              options={{ ...headerOptions, headerShown: true, title: "HOW IT WORKS" }}
            />
            <Stack.Screen
              name="Leaderboard"
              component={LeaderboardScreen}
              options={{ ...headerOptions, headerShown: true, title: "" }}
            />
            <Stack.Screen
              name="Stats"
              component={StatsScreen}
              options={{ ...headerOptions, headerShown: true, title: "YOUR STATS" }}
            />
            <Stack.Screen name="RaceLive" component={RaceLiveScreen} />
            <Stack.Screen name="RaceResult" component={RaceResultScreen} />
            <Stack.Screen name="SoloRun" component={SoloRunScreen} />
          </>
        )}
      </Stack.Navigator>
      </NavigationContainer>
    </ProximityVoiceProvider>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
});
