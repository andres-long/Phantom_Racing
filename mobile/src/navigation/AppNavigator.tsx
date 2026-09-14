import React from "react";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useUser } from "../context/UserContext";
import DisclaimerScreen from "../screens/DisclaimerScreen";
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
  const { disclaimerAccepted } = useUser();

  // NOTE: `initialRouteName` is only read once, when the navigator first
  // mounts -- React Navigation does not react to it changing later. So we
  // can't just flip initialRouteName after acceptDisclaimer() runs; instead
  // we swap which screens are registered (the standard React Navigation
  // "auth flow" pattern: https://reactnavigation.org/docs/auth-flow/).
  // When the set of screens changes, the navigator automatically resets to
  // the first screen in the new set.
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!disclaimerAccepted ? (
          <Stack.Screen name="Disclaimer" component={DisclaimerScreen} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="CreateSegment" component={CreateSegmentScreen} />
            <Stack.Screen name="RecordRun" component={RecordRunScreen} />
            <Stack.Screen name="RunSummary" component={RunSummaryScreen} />
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
