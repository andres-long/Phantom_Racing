import { TurboModuleRegistry, NativeModules } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

// The share card needs three native pieces -- picking a photo, turning the
// card into an image, and handing that image to Instagram/WhatsApp/etc. The
// app build on a phone only has them once it's been rebuilt with them, so
// each is looked up here without ever throwing: on an older build the share
// screen still works, it just falls back to "take a screenshot".
//
// Every module is required lazily (inside a function) because importing any
// of them at the top of a file throws straight away on a build without it.

function hasViewShot(): boolean {
  try {
    return !!(TurboModuleRegistry.get("RNViewShot") || NativeModules.RNViewShot);
  } catch {
    return false;
  }
}

export const shareSupport = {
  picker: !!requireOptionalNativeModule("ExponentImagePicker"),
  capture: hasViewShot(),
  sharing: !!requireOptionalNativeModule("ExpoSharing"),
};

// Can the card be turned into an image and sent to another app?
export const canShareImage = shareSupport.capture && shareSupport.sharing;

// A photo from the gallery (or the camera). null if cancelled/unavailable.
export async function pickPhoto(fromCamera: boolean): Promise<string | null> {
  if (!shareSupport.picker) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ImagePicker = require("expo-image-picker") as typeof import("expo-image-picker");
  if (fromCamera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("Camera permission is needed to take a photo.");
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    return res.canceled ? null : res.assets[0]?.uri ?? null;
  }
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
  return res.canceled ? null : res.assets[0]?.uri ?? null;
}

// Renders a view to a PNG file (story size) and opens the share sheet.
export async function shareViewAsImage(view: any, width: number, height: number): Promise<void> {
  if (!canShareImage) throw new Error("Sharing images needs the app update.");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { captureRef } = require("react-native-view-shot") as typeof import("react-native-view-shot");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Sharing = require("expo-sharing") as typeof import("expo-sharing");
  const uri = await captureRef(view, { format: "png", quality: 1, result: "tmpfile", width, height });
  await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share your drive", UTI: "public.png" });
}
