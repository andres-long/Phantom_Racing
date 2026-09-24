import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { LatLng, RaceChallenge } from "../types";

const POLL_MS = 3000;

// Race challenges addressed to you, for the screens you drive on. Only Home
// used to listen for these -- and Home stops listening as soon as you leave
// it -- so a challenge sent while you were recording just timed out unseen.
export function useIncomingRace(enabled: boolean) {
  const { user } = useUser();
  const [incoming, setIncoming] = useState<RaceChallenge | null>(null);
  const [responding, setResponding] = useState(false);
  const inFlight = useRef(false);
  // Ones already answered here, so a slow poll can't pop them back up.
  const answered = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !user) {
      setIncoming(null);
      return;
    }
    let cancelled = false;
    const deviceId = user.deviceId;
    const tick = async () => {
      if (inFlight.current || AppState.currentState !== "active") return;
      inFlight.current = true;
      try {
        const races = await api.getIncomingRaceChallenges(deviceId);
        if (cancelled) return;
        setIncoming(races.find((r) => !answered.current.has(r.id)) ?? null);
      } catch {
        // Next tick retries.
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, user]);

  // Resolves to the accepted race (so the caller can open it), or null.
  const respond = useCallback(
    async (accept: boolean, position: LatLng | null): Promise<RaceChallenge | null> => {
      if (!user || !incoming || responding) return null;
      const race = incoming;
      answered.current.add(race.id);
      setIncoming(null);
      setResponding(true);
      try {
        const updated = await api.respondToRaceChallenge(race.id, user.deviceId, accept, position);
        return accept && updated.status === "accepted" ? updated : null;
      } catch {
        return null;
      } finally {
        setResponding(false);
      }
    },
    [user, incoming, responding]
  );

  return { incoming, responding, respond };
}
