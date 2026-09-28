import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type MapView from "react-native-maps";
import type { Region } from "react-native-maps";
import { LatLng } from "../types";

// The map keeps you in the middle while you drive, at street level -- close
// enough to read the street names and see the next turn coming. The camera
// button switches between views (close / street / wide); a pinch sets any
// zoom in between and it sticks (shared by every driving screen, remembered
// across launches) instead of snapping back on the next fix. Dragging the
// map away pauses following; the target button (or, on driving screens, a
// few seconds without touching it) brings it back to you.
//
// Deliberately doesn't trust react-native-maps' `isGesture` flag: our own
// camera moves can come back flagged as gestures, which kept the map pausing
// itself and never settling on you. A finger on the map is known for sure
// from the touch events instead (spread `mapProps` onto the MapView), and
// only camera changes that follow a touch count as yours.

export const CAMERA_VIEWS = [
  { label: "CLOSE", zoom: 18 },
  { label: "STREET", zoom: 17 },
  { label: "WIDE", zoom: 15 },
];
export const DEFAULT_FOLLOW_ZOOM = 17;
const MIN_ZOOM = 11;
const MAX_ZOOM = 20;
const STORAGE_KEY = "phantom.followZoom";
// While a finger is on the map, following waits.
const TOUCH_HOLD_MS = 1500;
// Dragged the centre further than this many screen points from you: that's
// looking around, so following pauses.
const PAN_AWAY_PX = 90;

let sharedZoom = DEFAULT_FOLLOW_ZOOM;
let loaded = false;
const listeners = new Set<(z: number) => void>();

function clampZoom(z: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function publishZoom(z: number) {
  sharedZoom = clampZoom(z);
  listeners.forEach((l) => l(sharedZoom));
  AsyncStorage.setItem(STORAGE_KEY, String(sharedZoom)).catch(() => {});
}

async function loadZoomOnce() {
  if (loaded) return;
  loaded = true;
  try {
    const v = Number(await AsyncStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(v) && v > 0) {
      sharedZoom = clampZoom(v);
      listeners.forEach((l) => l(sharedZoom));
    }
  } catch {
    // Default zoom it is.
  }
}

export function viewLabelFor(zoom: number) {
  const exact = CAMERA_VIEWS.find((v) => Math.abs(v.zoom - zoom) < 0.25);
  return exact ? exact.label : `ZOOM ${zoom.toFixed(1)}`;
}

function metersBetween(a: LatLng, b: LatLng) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = dLng * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.sqrt(x * x + dLat * dLat) * 6371000;
}

export function useFollowCamera(
  mapRef: RefObject<MapView | null>,
  // After panning away, following comes back on its own after this long
  // (0 = only via the target button, like Home's browse-the-map mode).
  { autoResumeMs = 8000 }: { autoResumeMs?: number } = {}
) {
  const [zoom, setZoom] = useState(sharedZoom);
  const [following, setFollowing] = useState(true);
  const zoomRef = useRef(sharedZoom);
  const followingRef = useRef(true);
  const pausedAtRef = useRef(0);
  const lastPosRef = useRef<LatLng | null>(null);
  const touchedAtRef = useRef(0);
  const touchingRef = useRef(false);

  useEffect(() => {
    const l = (z: number) => {
      zoomRef.current = z;
      setZoom(z);
    };
    listeners.add(l);
    loadZoomOnce();
    return () => {
      listeners.delete(l);
    };
  }, []);

  const setFollowingBoth = useCallback((on: boolean) => {
    followingRef.current = on;
    setFollowing(on);
    if (!on) pausedAtRef.current = Date.now();
  }, []);

  const moveTo = useCallback(
    (pos: LatLng, duration: number) => {
      mapRef.current?.animateCamera(
        { center: { latitude: pos.lat, longitude: pos.lng }, zoom: zoomRef.current },
        { duration }
      );
    },
    [mapRef]
  );

  // Call with every new position. Keeps you centred unless you've panned
  // away (or have a finger on the map right now).
  const follow = useCallback(
    (pos: LatLng, duration = 500) => {
      lastPosRef.current = pos;
      const now = Date.now();
      if (!followingRef.current) {
        if (autoResumeMs > 0 && now - pausedAtRef.current > autoResumeMs) setFollowingBoth(true);
        else return;
      }
      if (touchingRef.current || now - touchedAtRef.current < TOUCH_HOLD_MS) return;
      moveTo(pos, duration);
    },
    [moveTo, autoResumeMs, setFollowingBoth]
  );

  // The target button: back to you, and keep following.
  const recenter = useCallback(
    (pos?: LatLng | null) => {
      if (pos) lastPosRef.current = pos;
      touchedAtRef.current = 0;
      setFollowingBoth(true);
      const p = lastPosRef.current;
      if (p) moveTo(p, 400);
    },
    [moveTo, setFollowingBoth]
  );

  // The camera button: next view down (close -> street -> wide -> close).
  const cycleView = useCallback(() => {
    const cur = zoomRef.current;
    const next = CAMERA_VIEWS.find((v) => v.zoom < cur - 0.25) ?? CAMERA_VIEWS[0];
    publishZoom(next.zoom);
    zoomRef.current = sharedZoom;
    touchedAtRef.current = 0;
    const p = lastPosRef.current;
    if (p && followingRef.current) moveTo(p, 300);
    else mapRef.current?.animateCamera({ zoom: sharedZoom }, { duration: 300 });
  }, [mapRef, moveTo]);

  // Wire these to the MapView (spread `mapProps`).
  const onPanDrag = useCallback(() => {
    touchedAtRef.current = Date.now();
  }, []);
  const onTouchStart = useCallback(() => {
    touchingRef.current = true;
    touchedAtRef.current = Date.now();
  }, []);
  const onTouchEnd = useCallback(() => {
    touchingRef.current = false;
    touchedAtRef.current = Date.now();
  }, []);

  const onRegionChangeComplete = useCallback(
    async (_r?: Region) => {
      // Only a move that follows a touch is the user's; anything else (our
      // own follow, fitting a course on screen, the first layout) is ours.
      const touched = touchingRef.current || Date.now() - touchedAtRef.current < 3000;
      if (!touched) return;
      let cam;
      try {
        cam = await mapRef.current?.getCamera();
      } catch {
        return;
      }
      if (!cam) return;
      if (typeof cam.zoom === "number" && Math.abs(cam.zoom - zoomRef.current) > 0.1) {
        // A pinch: that's the zoom now.
        publishZoom(cam.zoom);
        zoomRef.current = sharedZoom;
      }
      const me = lastPosRef.current;
      if (me && cam.center) {
        const z = typeof cam.zoom === "number" ? cam.zoom : zoomRef.current;
        const metersPerPoint = (156543.03 * Math.cos((me.lat * Math.PI) / 180)) / Math.pow(2, z);
        const off = metersBetween(me, { lat: cam.center.latitude, lng: cam.center.longitude });
        if (off > PAN_AWAY_PX * metersPerPoint && followingRef.current) setFollowingBoth(false);
      }
    },
    [mapRef, setFollowingBoth]
  );

  return {
    zoom,
    viewLabel: viewLabelFor(zoom),
    following,
    follow,
    recenter,
    cycleView,
    onPanDrag,
    onRegionChangeComplete,
    mapProps: { onPanDrag, onTouchStart, onTouchEnd, onRegionChangeComplete },
  };
}
