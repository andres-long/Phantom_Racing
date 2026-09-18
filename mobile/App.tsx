import React from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useFonts, Orbitron_500Medium, Orbitron_700Bold, Orbitron_900Black } from "@expo-google-fonts/orbitron";
import { UserProvider } from "./src/context/UserContext";
import AppNavigator from "./src/navigation/AppNavigator";
import { colors } from "./src/theme";

export default function App() {
  // The Orbitron display font (headings, buttons, HUD numbers) has to
  // finish loading before any screen renders with it, or text briefly
  // flashes in the system font and reflows. This gate is quick (a bundled
  // local font, not a network fetch) so it's just a blank branded moment,
  // not a real loading screen.
  const [fontsLoaded] = useFonts({
    Orbitron_500Medium,
    Orbitron_700Bold,
    Orbitron_900Black,
  });

  if (!fontsLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <UserProvider>
        <StatusBar style="light" />
        <AppNavigator />
      </UserProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
});
