import React, { createContext, useCallback, useContext, useRef } from "react";
import { useProximityVoice } from "../hooks/useProximityVoice";
import { LatLng, VoicePeer } from "../types";

type ProximityVoiceContextValue = {
  connectedPeers: VoicePeer[];
  talking: boolean;
  setTalking: (value: boolean) => void;
  micReady: boolean;
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
  const { connectedPeers, talking, setTalking, micReady } = useProximityVoice(posRef);

  const reportPosition = useCallback((coords: LatLng, heading: number | null) => {
    posRef.current = { coords, heading };
  }, []);

  const value: ProximityVoiceContextValue = { connectedPeers, talking, setTalking, micReady, reportPosition };

  return <ProximityVoiceContext.Provider value={value}>{children}</ProximityVoiceContext.Provider>;
}

export function useProximityVoiceContext() {
  const ctx = useContext(ProximityVoiceContext);
  if (!ctx) {
    throw new Error("useProximityVoiceContext must be used within a ProximityVoiceProvider");
  }
  return ctx;
}
