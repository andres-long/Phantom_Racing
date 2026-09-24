import { useCallback, useEffect, useRef } from "react";

// Below this, a GPS speed reading is noise, not movement. A phone sitting
// still still reports small doppler speeds (a few km/h, occasionally more
// on a poor fix) -- that's what showed up as "speed while stationary".
const STATIONARY_KMH = 3;
// With a fix this vague, low speeds are indistinguishable from drift too.
const POOR_ACCURACY_M = 30;
const POOR_ACCURACY_MIN_KMH = 10;

// A GPS fix's speed (metres/second, as the OS reports it -- possibly null
// or -1 when unknown) turned into a km/h reading that's 0 when you're
// actually stopped.
export function cleanSpeedKmh(rawMetersPerSecond: number | null | undefined, accuracyM?: number | null): number {
  if (rawMetersPerSecond == null || !Number.isFinite(rawMetersPerSecond) || rawMetersPerSecond <= 0) return 0;
  const kmh = rawMetersPerSecond * 3.6;
  if (kmh < STATIONARY_KMH) return 0;
  if (accuracyM != null && accuracyM > POOR_ACCURACY_M && kmh < POOR_ACCURACY_MIN_KMH) return 0;
  return kmh;
}

// The other half of the stationary problem: location updates are only
// delivered after you've moved a few metres, so when you stop, updates
// simply stop -- and the speed readout stays frozen on whatever the last
// fix said while you were still rolling to a halt. No fix for this long
// means you're not moving, so the readout goes back to 0.
const STALE_FIX_MS = 3500;

// Call the returned function on every GPS fix; `onStale` fires once when
// fixes stop arriving for STALE_FIX_MS (and again after the next stall).
export function useStaleSpeedReset(onStale: () => void) {
  const lastFixAt = useRef(0);
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;

  useEffect(() => {
    const t = setInterval(() => {
      if (lastFixAt.current > 0 && Date.now() - lastFixAt.current > STALE_FIX_MS) {
        lastFixAt.current = 0;
        onStaleRef.current();
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return useCallback(() => {
    lastFixAt.current = Date.now();
  }, []);
}
