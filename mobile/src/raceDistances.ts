import { RaceDistanceKey } from "./types";

// Mirrors RACE_DISTANCES on the backend (server/server.js) exactly -- kept
// as a fixed, non-editable set (the classic drag-race lengths) so client and
// server always agree on what "1 MILE" means without the app having to ask
// the server what the options are.
export const RACE_DISTANCES: { key: RaceDistanceKey; meters: number; label: string }[] = [
  { key: "quarter", meters: 402.336, label: "1/4 MILE" },
  { key: "mile", meters: 1609.344, label: "1 MILE" },
  { key: "five", meters: 8046.72, label: "5 MILES" },
];
