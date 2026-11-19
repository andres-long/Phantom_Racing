// Keeps GPS recording alive when the phone locks or you switch away from
// the app -- previously, both "track a new segment" and "race a segment"
// used a plain `Location.watchPositionAsync`, which Android pauses once the
// app leaves the foreground (a screen lock counts). Google/Expo's
// documented fix for continuous tracking (the same pattern Strava-style
// apps use) is `Location.startLocationUpdatesAsync`: it registers a
// TaskManager task at the OS level and runs a persistent foreground-service
// notification, so location updates keep flowing regardless of whether the
// app is on screen. `defineTask` MUST run at module scope (not inside a
// component) so it's registered as soon as the JS bundle loads -- this
// module is imported once from App.tsx for exactly that reason.
//
// Because the task callback fires outside of any screen's React lifecycle,
// it can't call component state setters directly. Instead it forwards
// batches of points to whichever listener the active recording screen
// (RecordRunScreen / CreateSegmentScreen / GoRaceScreen) has registered via
// setBackgroundLocationListener, and the screen folds them into its own
// trace state exactly like it used to handle each watchPositionAsync tick.
//
// Several screens can now track at once -- e.g. a live race started while a
// Go To drive or a segment recording keeps running underneath -- so each
// caller names itself (`owner`). Every owner gets every point, and the
// native task only stops once the last owner has stopped; previously the
// race's own "stop" would have killed the recording underneath it.
import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import { Alert, AppState, Linking, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cleanSpeedKmh } from "./utils/speed";

export const BACKGROUND_LOCATION_TASK = "nfs-background-location-task";

export type BackgroundLocationPoint = {
  lat: number;
  lng: number;
  t: number;
  heading: number | null;
  speedKmh: number;
};

export type TrackingOwner = "run" | "segment" | "trip" | "race" | "solo";

type Listener = (points: BackgroundLocationPoint[]) => void;
const listeners = new Map<TrackingOwner, Listener>();
const activeOwners = new Set<TrackingOwner>();

// Keeping a long drive alive. Two things used to end a recording after a
// while: Android (especially battery savers on Xiaomi/Samsung) quietly
// stopping the location updates, and points arriving while no screen was
// listening (JS restarted, or a listener mid-swap) simply being dropped.
// So: remember what we started with, watch for updates going missing and
// restart them, and hold on to points nobody was listening for.
let lastNotificationBody = "Recording your drive -- tap to return to Phantom Racing.";
let lastPointAt = 0;
let lastRestartAt = 0;
const pendingPoints: BackgroundLocationPoint[] = [];
const MAX_PENDING_POINTS = 5000;
// No point for this long while something is recording (and the app is up):
// the provider has stalled -- restart it. Parked cars legitimately send
// nothing (updates need ~3 m of movement), so this is generous.
const STALL_RESTART_MS = 4 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 20000;

export function setBackgroundLocationListener(fn: Listener | null, owner: TrackingOwner) {
  if (fn) {
    listeners.set(owner, fn);
    // Hand over anything that arrived while nobody was listening.
    if (pendingPoints.length > 0) {
      const backlog = pendingPoints.splice(0, pendingPoints.length);
      try {
        fn(backlog);
      } catch (e) {
        console.warn("Background location listener failed:", e);
      }
    }
  } else listeners.delete(owner);
}

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn("Background location task error:", error.message);
    return;
  }
  if (!data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;

  const points: BackgroundLocationPoint[] = locations.map((loc) => ({
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    t: loc.timestamp,
    heading: loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : null,
    // Filtered so a phone sitting still reads 0, not GPS drift.
    speedKmh: cleanSpeedKmh(loc.coords.speed, loc.coords.accuracy),
  }));

  lastPointAt = Date.now();
  if (listeners.size === 0) {
    // Nobody listening right now (JS just restarted, or a screen is
    // re-registering) -- keep them for the next listener instead of losing
    // part of the drive.
    pendingPoints.push(...points);
    if (pendingPoints.length > MAX_PENDING_POINTS) pendingPoints.splice(0, pendingPoints.length - MAX_PENDING_POINTS);
    return;
  }
  for (const listener of listeners.values()) {
    try {
      listener(points);
    } catch (e) {
      console.warn("Background location listener failed:", e);
    }
  }
});

async function startUpdates() {
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,
    distanceInterval: 3,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    foregroundService: {
      notificationTitle: "Phantom Racing is recording",
      notificationBody: lastNotificationBody,
      notificationColor: "#2ce8f5",
      killServiceOnDestroy: false,
    },
  });
}

// Something is recording but the updates stopped (the OS killed the
// service) or went silent for minutes: start them again. Runs every 20 s
// while the app is up and whenever it comes back to the foreground.
async function ensureTrackingAlive() {
  if (activeOwners.size === 0) return;
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false);
    const now = Date.now();
    if (!started) {
      lastRestartAt = now;
      await startUpdates();
      return;
    }
    const stalled = lastPointAt > 0 && now - lastPointAt > STALL_RESTART_MS;
    if (stalled && now - lastRestartAt > STALL_RESTART_MS) {
      lastRestartAt = now;
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {});
      if (activeOwners.size > 0) await startUpdates();
    }
  } catch (e) {
    console.warn("Couldn't restart location updates:", e);
  }
}

setInterval(() => {
  ensureTrackingAlive();
}, WATCHDOG_INTERVAL_MS);
AppState.addEventListener("change", (s) => {
  if (s === "active") ensureTrackingAlive();
});

// Once per install, the first time a drive starts on Android: battery
// savers are the usual reason a long recording dies, so offer the setting
// that exempts the app.
const BATTERY_TIP_KEY = "phantom.batteryTipShown";
async function maybeShowBatteryTip() {
  if (Platform.OS !== "android") return;
  try {
    if (await AsyncStorage.getItem(BATTERY_TIP_KEY)) return;
    await AsyncStorage.setItem(BATTERY_TIP_KEY, "1");
  } catch {
    return;
  }
  Alert.alert(
    "Keep long drives recording",
    'Some phones stop apps in the background to save battery, which can cut a long recording short. Set Phantom Racing\'s battery use to "Unrestricted" (or "No restrictions") so it keeps recording.',
    [
      { text: "Later", style: "cancel" },
      { text: "Open settings", onPress: () => openBatterySettings() },
    ]
  );
}

// The phone's battery-optimisation list (where the app can be exempted),
// or the app's own settings page if that screen isn't available.
export function openBatterySettings() {
  if (Platform.OS !== "android") {
    Linking.openSettings();
    return;
  }
  Linking.sendIntent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS").catch(() => Linking.openSettings());
}

/**
 * Requests background ("Allow all the time") location permission, on top of
 * the foreground permission a screen should already have requested. Best-
 * effort: if the user declines, recording still works while the app is in
 * the foreground -- it just won't survive a lock/backgrounding, same as
 * before this fix. Returns whether it was granted so the caller can warn.
 */
export async function requestBackgroundLocationPermission(): Promise<boolean> {
  const result = await Location.requestBackgroundPermissionsAsync();
  return result.status === "granted";
}

/**
 * Starts (or, if already running, no-ops) the background-capable location
 * task. Delivers updates to whatever listener is currently registered via
 * setBackgroundLocationListener, whether the app is foregrounded or not.
 */
export async function startBackgroundTracking(notificationBody: string, owner: TrackingOwner) {
  activeOwners.add(owner);
  lastNotificationBody = notificationBody;
  maybeShowBatteryTip();
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false
  );
  if (alreadyStarted) return;
  lastPointAt = Date.now();
  await startUpdates();
}

// Stops this owner's tracking. Safe to call more than once (screens call it
// on finish and again on unmount). The GPS task itself keeps running while
// any other owner still needs it.
export async function stopBackgroundTracking(owner: TrackingOwner) {
  activeOwners.delete(owner);
  listeners.delete(owner);
  if (activeOwners.size > 0) return;
  pendingPoints.length = 0;
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false
  );
  // Re-check: another owner may have started while we were awaiting.
  if (alreadyStarted && activeOwners.size === 0) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}
