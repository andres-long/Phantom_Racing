import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { PresenceUser } from "../types";
import { PresencePositionRef } from "./usePresenceHeartbeat";

// Same cadence as Home's presence refresh.
const REFRESH_MS = 5000;
// How far around you to look, in degrees of latitude (~3.3 km) -- close
// enough to be someone you could actually pull up next to and race.
const RADIUS_DEG = 0.03;

// Other racers around you, for the screens you drive on (racing a track,
// recording a new one, a Go To drive). Home has always shown them; these
// screens didn't, so the moment you started driving, everyone else vanished
// and there was no way to challenge them. Reads your position from the same
// ref the presence heartbeat uses, so it never restarts on every GPS point.
export function useNearbyRacers(posRef: PresencePositionRef, enabled: boolean): PresenceUser[] {
  const { user } = useUser();
  const [racers, setRacers] = useState<PresenceUser[]>([]);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !user) {
      setRacers([]);
      return;
    }
    let cancelled = false;
    const deviceId = user.deviceId;

    const tick = async () => {
      const pos = posRef.current?.coords;
      if (!pos || inFlight.current || AppState.currentState !== "active") return;
      inFlight.current = true;
      try {
        const lngRadius = RADIUS_DEG / Math.max(0.2, Math.cos((pos.lat * Math.PI) / 180));
        const { users } = await api.queryPresence(deviceId, {
          north: pos.lat + RADIUS_DEG,
          south: pos.lat - RADIUS_DEG,
          east: pos.lng + lngRadius,
          west: pos.lng - lngRadius,
        });
        if (!cancelled) setRacers(users);
      } catch {
        // Next tick retries; keep showing the last known positions.
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const t = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, user, posRef]);

  return racers;
}
