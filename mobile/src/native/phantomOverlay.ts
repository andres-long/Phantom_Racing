import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

// The app's own native module (modules/phantom-overlay): the round minimap
// bubble that floats over other apps, and the home-screen minimap widget.
// Android only, and only in a build made after it was added -- in an older
// build (or Expo Go) this is null and the bubble option simply isn't shown.
type PhantomOverlayModule = {
  canDrawOverlays(): boolean;
  openOverlaySettings(): void;
  show(): void;
  hide(): void;
  isShowing(): boolean;
  // Your position, which way is up (degrees from north), and the speed text.
  update(lat: number, lng: number, headingDeg: number, speed: number, unit: string): void;
  // The line to follow (course / route), or empty arrays for none.
  setRoute(lats: number[], lngs: number[]): void;
  // Dots: kind 0 = racer, 1 = HP-matched racer, 2 = finish / destination.
  setMarkers(lats: number[], lngs: number[], kinds: number[]): void;
};

export const PhantomOverlay: PhantomOverlayModule | null =
  Platform.OS === "android" ? requireOptionalNativeModule<PhantomOverlayModule>("PhantomOverlay") : null;
