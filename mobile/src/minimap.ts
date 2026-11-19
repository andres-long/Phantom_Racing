// The NFS-style round minimap, everywhere it shows up:
//  - "minimap mode" on the driving screens (the map shown through a glowing
//    circle -- see MinimapFrame), toggled with the radar button and
//    remembered like the camera zoom;
//  - the full-screen Minimap screen (from Home, or the home-screen widget);
//  - the bubble that floats over other apps while you drive (Android, see
//    native/phantomOverlay.ts): shown whenever the app is in the
//    background with the bubble switched on, fed from here with your
//    position, the line you're following and nearby racers.
import { useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { PhantomOverlay } from "./native/phantomOverlay";
import { haversine } from "./utils/geo";
import type { LatLng } from "./types";

// ---- Minimap mode on the driving screens ---------------------------------

const MODE_KEY = "phantom.minimapMode";
let minimapOn = false;
let modeLoaded = false;
const modeListeners = new Set<(on: boolean) => void>();

function loadModeOnce() {
  if (modeLoaded) return;
  modeLoaded = true;
  AsyncStorage.getItem(MODE_KEY)
    .then((v) => {
      if (v === "1") setMinimapMode(true, false);
    })
    .catch(() => {});
}

export function setMinimapMode(on: boolean, persist = true) {
  minimapOn = on;
  modeListeners.forEach((l) => l(on));
  if (persist) AsyncStorage.setItem(MODE_KEY, on ? "1" : "0").catch(() => {});
}

export function useMinimapMode(): [boolean, () => void] {
  const [on, setOn] = useState(minimapOn);
  useEffect(() => {
    modeListeners.add(setOn);
    loadModeOnce();
    setOn(minimapOn);
    return () => {
      modeListeners.delete(setOn);
    };
  }, []);
  return [on, () => setMinimapMode(!minimapOn)];
}

// ---- What the bubble shows ----------------------------------------------

export type MinimapMarker = LatLng & { kind: "racer" | "match" | "finish" };

let lastPos: LatLng | null = null;
let course: number | null = null;
let anchor: LatLng | null = null;
let moveBearing: number | null = null;
let speedText = { value: 0, unit: "km/h" };

function bearingDeg(a: LatLng, b: LatLng) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// Units for the bubble's speed readout (the app's setting).
export function setMinimapUnits(imperial: boolean) {
  speedText = { ...speedText, unit: imperial ? "mph" : "km/h" };
}

// Every GPS fix the app gets (foreground or background) comes through here.
export function feedMinimap(p: { lat: number; lng: number; heading?: number | null; speedKmh?: number }) {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
  const pos = { lat: p.lat, lng: p.lng };
  // Same rules as the driving screens' camera: which way you've actually
  // moved beats a GPS heading that disagrees (or Android's bogus 0).
  if (!anchor) anchor = pos;
  else if (haversine(anchor, pos) >= 8) {
    moveBearing = bearingDeg(anchor, pos);
    anchor = pos;
  }
  const speed = p.speedKmh ?? 0;
  let gps = p.heading != null && p.heading >= 0 && speed >= 10 ? p.heading : null;
  if (gps === 0 && (moveBearing == null || angleDiff(moveBearing, 0) > 45)) gps = null;
  if (gps != null && moveBearing != null && angleDiff(gps, moveBearing) > 70) gps = null;
  if (gps != null) course = gps;
  else if (moveBearing != null && speed >= 4) course = moveBearing;
  lastPos = pos;
  const shown = speedText.unit === "mph" ? speed * 0.621371 : speed;
  speedText = { ...speedText, value: Math.round(shown) };
  if (bubbleOn && PhantomOverlay) {
    try {
      PhantomOverlay.update(pos.lat, pos.lng, course ?? 0, speedText.value, speedText.unit);
    } catch {}
  }
}

export function getMinimapPosition() {
  return lastPos;
}

let routeOwner: string | null = null;

// The line you're following (race course, Go To route, track) -- shown in
// the bubble. `owner` so one screen clearing doesn't wipe another's.
export function setMinimapRoute(owner: string, points: LatLng[] | null) {
  if (!points) {
    if (routeOwner !== owner) return;
    routeOwner = null;
  } else routeOwner = owner;
  if (!PhantomOverlay) return;
  // Plenty for a little circle, and cheap to send.
  const pts = points ?? [];
  const stride = Math.max(1, Math.ceil(pts.length / 600));
  const thin = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  try {
    PhantomOverlay.setRoute(
      thin.map((p) => p.lat),
      thin.map((p) => p.lng)
    );
  } catch {}
}

export function setMinimapMarkers(markers: MinimapMarker[]) {
  if (!PhantomOverlay) return;
  const kind = { racer: 0, match: 1, finish: 2 } as const;
  try {
    PhantomOverlay.setMarkers(
      markers.map((m) => m.lat),
      markers.map((m) => m.lng),
      markers.map((m) => kind[m.kind])
    );
  } catch {}
}

// ---- The bubble over other apps ------------------------------------------

let bubbleOn = false;
const bubbleListeners = new Set<(on: boolean) => void>();

export const bubbleSupported = !!PhantomOverlay;

export function isBubbleOn() {
  return bubbleOn;
}

export function useBubble(): boolean {
  const [on, setOn] = useState(bubbleOn);
  useEffect(() => {
    bubbleListeners.add(setOn);
    setOn(bubbleOn);
    return () => {
      bubbleListeners.delete(setOn);
    };
  }, []);
  return on;
}

export function canShowBubble() {
  try {
    return !!PhantomOverlay?.canDrawOverlays();
  } catch {
    return false;
  }
}

export function openBubblePermission() {
  try {
    PhantomOverlay?.openOverlaySettings();
  } catch {
    Linking.openSettings();
  }
}

// Switch the bubble on/off. It appears whenever you leave the app (and
// hides again when you come back -- the app has its own minimap).
export function setBubbleOn(on: boolean) {
  bubbleOn = on && !!PhantomOverlay;
  bubbleListeners.forEach((l) => l(bubbleOn));
  if (!bubbleOn) {
    try {
      PhantomOverlay?.hide();
    } catch {}
  } else if (lastPos && PhantomOverlay) {
    try {
      PhantomOverlay.update(lastPos.lat, lastPos.lng, course ?? 0, speedText.value, speedText.unit);
    } catch {}
  }
}

AppState.addEventListener("change", (s) => {
  if (!PhantomOverlay || !bubbleOn) return;
  try {
    if (s === "background") PhantomOverlay.show();
    else if (s === "active") PhantomOverlay.hide();
  } catch {}
});
