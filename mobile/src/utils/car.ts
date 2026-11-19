import { Car } from "../types";

// HP-matched racing: two cars are a fair match when their horsepower is
// within this much of each other (relative to the stronger car).
export const HP_MATCH_TOLERANCE = 0.2;

export function isHpMatch(mine: Car | null | undefined, theirs: Car | null | undefined): boolean {
  if (!mine || !theirs) return false;
  const hi = Math.max(mine.hp, theirs.hp);
  return hi > 0 && Math.abs(mine.hp - theirs.hp) / hi <= HP_MATCH_TOLERANCE;
}

// "Mustang GT -- 450 HP", or just "450 HP".
export function carLabel(car: Car | null | undefined): string {
  if (!car) return "";
  const name = [car.make, car.model].filter(Boolean).join(" ").trim();
  return name ? `${name} -- ${car.hp} HP` : `${car.hp} HP`;
}

export function hpLabel(car: Car | null | undefined): string {
  return car ? `${car.hp} HP` : "";
}
