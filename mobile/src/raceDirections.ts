import { RaceDirectionKey, LatLng } from "./types";

// Mirrors RACE_DIRECTIONS on the backend (server/server.js). Both racers
// agree on one compass direction, and progress counts only how far each of
// them gets *that way* -- so both are running the same race, and doubling
// back doesn't score.
export const RACE_DIRECTIONS: { key: RaceDirectionKey; label: string; short: string; bearing: number }[] = [
  { key: "north", label: "NORTH", short: "N", bearing: 0 },
  { key: "east", label: "EAST", short: "E", bearing: 90 },
  { key: "south", label: "SOUTH", short: "S", bearing: 180 },
  { key: "west", label: "WEST", short: "W", bearing: 270 },
];

const METERS_PER_DEG_LAT = 111320;

// How far `pos` has moved from `start` in the race's direction, in meters.
// Negative while you're behind the start line (drove the wrong way), so the
// caller clamps at 0. Uses a flat-earth approximation, which is plenty over
// race distances (at most a few miles).
export function directionalProgressM(start: LatLng, pos: LatLng, direction: RaceDirectionKey): number {
  const northM = (pos.lat - start.lat) * METERS_PER_DEG_LAT;
  const eastM = (pos.lng - start.lng) * METERS_PER_DEG_LAT * Math.cos((start.lat * Math.PI) / 180);
  switch (direction) {
    case "north":
      return northM;
    case "south":
      return -northM;
    case "east":
      return eastM;
    case "west":
      return -eastM;
    default:
      return northM;
  }
}
