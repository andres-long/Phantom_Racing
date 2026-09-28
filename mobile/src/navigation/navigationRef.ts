import { createNavigationContainerRef } from "@react-navigation/native";
import { RootStackParamList } from "../types";

// For the few things that live above the screens (the background track
// timer's result card) and still need to open one.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
