import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { useProximityVoice } from "../hooks/useProximityVoice";
import { LatLng, VoicePeer } from "../types";

type ProximityVoiceContextValue = {
  connectedPeers: VoicePeer[];
  talking: boolean;
  setTalking: (value: boolean) => void;
  micReady: boolean;
  // True once the user picked "don't ask again" for the mic -- only the
  // system settings screen can re-enable it from there.
  micBlocked: boolean;
  // Re-asks for the mic on demand (e.g. tapping "enable mic" after a denial).
  retryMic: () => void;
  // Screens that already track GPS (Home, a live race) call this as they
  // get fixes, the same way they already feed usePresenceHeartbeat's
  // position ref. Proximity voice doesn't own a location subscription of
  // its own -- it just reads whatever the current screen last reported.
  reportPosition: (coords: LatLng, heading: number | null) => void;
};

const ProximityVoiceContext = createContext<ProximityVoiceContextValue | null>(null);

// Owns the *one* proximity-voice engine for the whole app. See
// useProximityVoice's own comments for why this can't just be called
// per-screen: a single microphone stream and a destructively-drained
// signaling mailbox can't safely be shared by two independent instances,
// and Home stays mounted underneath every pushed screen (RaceLive
// included), so "call the hook in each screen that needs it" would mean
// two of them running at once.
//
// Mounted once, above the navigator (see AppNavigator.tsx), and consumed
// from wherever needs it -- Home's HUD, a live race's HUD -- via
// useProximityVoiceContext below.
export function ProximityVoiceProvider({ children }: { children: React.ReactNode }) {
  const posRef = useRef<{ coords: LatLng; heading: number | null } | null>(null);
  // Flips true on the first reported fix and stays true. It's what lets the
  // voice engine wait until location permission has been answered before it
  // asks for the mic (see useProximityVoice for why the two can't overlap).
  const [positionReady, setPositionReady] = useState(false);
  const positionReadyRef = useRef(false);

  const { connectedPeers, talking, setTalking, micReady, micBlocked, retryMic } = useProximityVoice(
    posRef,
    positionReady
  );

  const reportPosition = useCallback((coords: LatLng, heading: number | null) => {
    posRef.current = { coords, heading };
    if (!positionReadyRef.current) {
      positionReadyRef.current = true;
      setPositionReady(true);
    }
  }, []);

  const value: ProximityVoiceContextValue = {
    connectedPeers,
    talking,
    setTalking,
    micReady,
    micBlocked,
    retryMic,
    reportPosition,
  };

  return <ProximityVoiceContext.Provider value={value}>{children}</ProximityVoiceContext.Provider>;
}

export function useProximityVoiceContext() {
  const ctx = useContext(ProximityVoiceContext);
  if (!ctx) {
    throw new Error("useProximityVoiceContext must be used within a ProximityVoiceProvider");
  }
  return ctx;
}
