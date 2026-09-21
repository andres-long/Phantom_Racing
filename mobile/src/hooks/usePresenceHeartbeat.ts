import { MutableRefObject, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { LatLng } from "../types";

// Matches HomeScreen's own heartbeat cadence (see its HEARTBEAT_INTERVAL_MS)
// so a marker updates at the same rate everywhere, not just on Home.
const HEARTBEAT_INTERVAL_MS = 5000;

export type PresencePositionRef = MutableRefObject<{ coords: LatLng; heading: number | null } | null>;

// Keeps this device visible to other racers (see HomeScreen's presence
// markers) on screens other than Home -- racing a segment, recording a new
// one, or driving to a destination via Go To. Without this, a heartbeat
// only ever went out from Home, so the moment you left it to actually
// drive, your marker vanished from everyone else's map right when it would
// have been most useful (you're mid-race/mid-recording/mid-drive).
//
// Takes a ref, not the position itself, so the caller can update it from
// inside a location-listener closure (same pattern as HomeScreen's
// latestPosRef) without this hook's effect re-running -- and therefore
// without tearing down/restarting the interval -- on every GPS point.
export function usePresenceHeartbeat(posRef: PresencePositionRef) {
  const { user, incognito } = useUser();
  const userRef = useRef(user);
  const incognitoRef = useRef(incognito);

  useEffect(() => {
    userRef.current = user;
  }, [user]);
  useEffect(() => {
    incognitoRef.current = incognito;
  }, [incognito]);

  useEffect(() => {
    const tick = () => {
      const deviceId = userRef.current?.deviceId;
      const pos = posRef.current;
      if (!deviceId || !pos || AppState.currentState !== "active") return;
      api.sendHeartbeat(deviceId, pos.coords, pos.heading, incognitoRef.current).catch(() => {
        // Best-effort, same as Home's -- a dropped heartbeat just means this
        // one tick didn't update your position, not something worth
        // interrupting a race/recording/drive over.
      });
    };
    tick();
    const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
