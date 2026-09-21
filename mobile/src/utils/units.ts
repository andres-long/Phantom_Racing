// Speed/distance display formatting for the mph<->km/h unit preference (see
// UserContext's `units`). The backend always stores and returns speed in
// km/h and distance in meters, regardless of what the viewer has chosen --
// conversion is purely a display-layer concern, so every screen keeps
// working with the same numbers from the API and just formats them
// differently here.

export type Units = "metric" | "imperial";

const KMH_TO_MPH = 0.621371;
const M_TO_MI = 1 / 1609.344;
const M_TO_FT = 3.28084;

/** A km/h value (as stored/returned everywhere) rounded to a whole number in
 * whichever unit the viewer has chosen -- every speed HUD/stat in the app
 * can just drop this straight into text next to speedUnit(units). */
export function displaySpeedKmh(kmh: number, units: Units): number {
  return Math.round(units === "imperial" ? kmh * KMH_TO_MPH : kmh);
}

export function speedUnit(units: Units): string {
  return units === "imperial" ? "mph" : "km/h";
}

/** Short, inline distance label ("X away", "X left") -- the small unit
 * (feet/meters) under roughly a tenth of a mile/kilometer, one decimal
 * place of the big unit (mi/km) above that. Always "<number> <unit>" (one
 * space) so callers that split on " " to lay out a value and its unit
 * separately (see StatsScreen) keep working. */
export function formatDistanceShort(m: number, units: Units): string {
  if (units === "imperial") {
    const feet = m * M_TO_FT;
    return feet < 528 ? `${Math.round(feet)} ft` : `${(feet / 5280).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Distance formatter for a track/trip's total length, where the number is
 * the main stat rather than a quick aside -- always the big unit (km/mi),
 * `decimals` places (2 by default, matching the app's existing track-length
 * style; pass 1 to match the shorter trip-summary style). */
export function formatDistanceLong(m: number, units: Units, decimals: number = 2): string {
  return units === "imperial" ? `${(m * M_TO_MI).toFixed(decimals)} mi` : `${(m / 1000).toFixed(decimals)} km`;
}
