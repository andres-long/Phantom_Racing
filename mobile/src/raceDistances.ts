import { RaceDistanceKey } from "./types";

// Mirrors RACE_DISTANCES on the backend (server/server.js) exactly -- kept
// as a fixed, non-editable set so client and server always agree on what
// "1 MILE" means without the app having to ask the server what the options
// are. The classic drag-race lengths, then the long hauls.
const MILE_M = 1609.344;
export const RACE_DISTANCES: { key: RaceDistanceKey; meters: number; label: string; short: string }[] = [
  { key: "quarter", meters: 402.336, label: "1/4 MILE", short: "1/4" },
  { key: "mile", meters: MILE_M, label: "1 MILE", short: "1 MI" },
  { key: "five", meters: 5 * MILE_M, label: "5 MILES", short: "5 MI" },
  { key: "m10", meters: 10 * MILE_M, label: "10 MILES", short: "10 MI" },
  { key: "m20", meters: 20 * MILE_M, label: "20 MILES", short: "20 MI" },
  { key: "m50", meters: 50 * MILE_M, label: "50 MILES", short: "50 MI" },
  { key: "m80", meters: 80 * MILE_M, label: "80 MILES", short: "80 MI" },
  { key: "m100", meters: 100 * MILE_M, label: "100 MILES", short: "100 MI" },
  { key: "m150", meters: 150 * MILE_M, label: "150 MILES", short: "150 MI" },
  { key: "m200", meters: 200 * MILE_M, label: "200 MILES", short: "200 MI" },
];

export function raceDistanceLabel(key: RaceDistanceKey): string {
  return RACE_DISTANCES.find((d) => d.key === key)?.label ?? key;
}
