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
import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";

export const BACKGROUND_LOCATION_TASK = "nfs-background-location-task";

export type BackgroundLocationPoint = {
  lat: number;
  lng: number;
  t: number;
  heading: number | null;
  speedKmh: number;
};

type Listener = (points: BackgroundLocationPoint[]) => void;
let activeListener: Listener | null = null;

export function setBackgroundLocationListener(fn: Listener | null) {
  activeListener = fn;
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
    speedKmh: Math.max(0, (loc.coords.speed ?? 0) * 3.6),
  }));

  activeListener?.(points);
});

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
export async function startBackgroundTracking(notificationBody: string) {
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false
  );
  if (alreadyStarted) return;
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,
    distanceInterval: 3,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: "Phantom Racing is recording",
      notificationBody,
      notificationColor: "#2ce8f5",
    },
  });
}

export async function stopBackgroundTracking() {
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false
  );
  if (alreadyStarted) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  activeListener = null;
}
