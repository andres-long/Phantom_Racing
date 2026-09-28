import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type MapView from "react-native-maps";
import type { Details, Region } from "react-native-maps";
import { LatLng } from "../types";

// The map follows you at street level while you drive -- close enough to
// read the street names and see the next turn coming -- at a zoom you set:
// pinch or tap +/- and it stays there (shared by every driving screen, and
// remembered across launches) instead of snapping back on the next fix.
export const DEFAULT_FOLLOW_ZOOM = 17;
const MIN_ZOOM = 11;
const MAX_ZOOM = 20;
const STORAGE_KEY = "phantom.followZoom";
// After you touch the map, following waits this long before re-centering,
// so it never fights a pinch or a look around.
const GESTURE_HOLD_MS = 2500;

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

export function useFollowCamera(mapRef: RefObject<MapView | null>) {
  const [zoom, setZoom] = useState(sharedZoom);
  const zoomRef = useRef(sharedZoom);
  const lastPosRef = useRef<LatLng | null>(null);
  const holdUntilRef = useRef(0);

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

  const moveTo = useCallback(
    (pos: LatLng, duration: number) => {
      mapRef.current?.animateCamera(
        { center: { latitude: pos.lat, longitude: pos.lng }, zoom: zoomRef.current },
        { duration }
      );
    },
    [mapRef]
  );

  // Call with every new position while driving. `force` (a recenter
  // button) skips the pause after touching the map.
  const follow = useCallback(
    (pos: LatLng, duration = 500, force = false) => {
      lastPosRef.current = pos;
      if (force) holdUntilRef.current = 0;
      else if (Date.now() < holdUntilRef.current) return;
      moveTo(pos, duration);
    },
    [moveTo]
  );

  const zoomBy = useCallback(
    (step: number) => {
      publishZoom(zoomRef.current + step);
      zoomRef.current = sharedZoom;
      holdUntilRef.current = 0;
      // Zoom where the map is looking; the next fix re-centres on you.
      mapRef.current?.animateCamera({ zoom: sharedZoom }, { duration: 250 });
    },
    [mapRef]
  );
  const zoomIn = useCallback(() => zoomBy(1), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(-1), [zoomBy]);

  // Wire both to the MapView: a pinch sets the zoom that following keeps.
  const onRegionChange = useCallback((_r: Region, details?: Details) => {
    if (details?.isGesture) holdUntilRef.current = Date.now() + GESTURE_HOLD_MS;
  }, []);
  const onRegionChangeComplete = useCallback(
    async (_r: Region, details?: Details) => {
      if (!details?.isGesture) return;
      holdUntilRef.current = Date.now() + GESTURE_HOLD_MS;
      try {
        const cam = await mapRef.current?.getCamera();
        if (cam && typeof cam.zoom === "number" && Math.abs(cam.zoom - zoomRef.current) > 0.05) {
          publishZoom(cam.zoom);
        }
      } catch {
        // Keep the zoom we had.
      }
    },
    [mapRef]
  );

  return { zoom, follow, zoomIn, zoomOut, onRegionChange, onRegionChangeComplete };
}
