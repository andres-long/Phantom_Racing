import React from "react";
import { StatusBar } from "expo-status-bar";
import { UserProvider } from "./src/context/UserContext";
import AppNavigator from "./src/navigation/AppNavigator";

export default function App() {
  return (
    <UserProvider>
      <StatusBar style="light" />
      <AppNavigator />
    </UserProvider>
  );
}
