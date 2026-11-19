import { api } from "./api/client";
import { LatLng } from "./types";
import {
  cumulativeDistances,
  advanceAlongPolyline,
  aheadWindowM,
  pointAtDistance,
} from "./utils/geo";

// Off the course by more than this, for a couple of fixes in a row: you've
// taken another road, so lay a new course instead of ending the run.
const OFF_COURSE_M = 60;
const OFF_COURSE_FIXES = 2;
// Don't ask for a new route more often than this.
const REROUTE_MIN_GAP_MS = 20000;
// Within this of the end of the course: you're over the line.
const FINISH_SLACK_M = 6;

export type CourseUpdate = {
  // How far you've got towards the finish, in the race's own distance
  // (target minus road distance still to go) -- never goes backwards.
  coveredM: number;
  finished: boolean;
  // A new course was laid (redraw it).
  rerouted: boolean;
};

// Follows you along a race/solo course (point A to point B), and when you
// leave it -- a wrong turn, a closed road, a road you'd rather take --
// re-lays it from where you are instead of stalling the run:
//  - a straight course is re-routed from you straight to the finish (B);
//  - a loop is routed back onto itself a little way ahead, then follows the
//    rest of the loop (routing a loop "to the finish" would cut it short,
//    because its finish is its start).
// Progress is measured as how much road is left to the finish, so a detour
// costs you time but never distance you'd already earned.
export class CourseFollower {
  private original: LatLng[];
  private originalCum: number[];
  private active: LatLng[];
  private cum: number[];
  private along = 0;
  private lastT = 0;
  private offFixes = 0;
  private lastRerouteAt = 0;
  private rerouting = false;
  private covered = 0;
  readonly targetM: number;
  readonly isLoop: boolean;
  reroutes = 0;

  constructor(course: LatLng[], targetM: number, isLoop = false) {
    this.original = course;
    this.originalCum = cumulativeDistances(course);
    this.active = course;
    this.cum = this.originalCum;
    this.targetM = targetM;
    this.isLoop = isLoop;
  }

  get points() {
    return this.active;
  }

  private get remaining() {
    return Math.max(0, this.cum[this.cum.length - 1] - this.along);
  }

  // One GPS fix. Call reroute() when it says so (it's async).
  update(p: LatLng, t: number): CourseUpdate & { needsReroute: boolean } {
    const gap = this.lastT ? t - this.lastT : 1000;
    this.lastT = t;
    const r = advanceAlongPolyline(this.active, this.cum, p, this.along, aheadWindowM(gap));
    this.along = r.distanceAlongM;
    this.offFixes = r.lateralDistanceM > OFF_COURSE_M ? this.offFixes + 1 : 0;
    this.covered = Math.max(this.covered, Math.min(this.targetM, this.targetM - this.remaining));
    const finished = this.remaining <= FINISH_SLACK_M;
    if (finished) this.covered = this.targetM;
    const needsReroute =
      !finished && !this.rerouting && this.offFixes >= OFF_COURSE_FIXES && Date.now() - this.lastRerouteAt > REROUTE_MIN_GAP_MS;
    return { coveredM: this.covered, finished, rerouted: false, needsReroute };
  }

  // Lay a new course from `from`. Resolves true if the course changed.
  async reroute(from: LatLng): Promise<boolean> {
    if (this.rerouting) return false;
    this.rerouting = true;
    this.lastRerouteAt = Date.now();
    try {
      // How far along the original course you'd got, for a loop's rejoin.
      const doneOnOriginal = Math.max(0, this.originalCum[this.originalCum.length - 1] - this.remaining);
      let points: LatLng[];
      if (this.isLoop) {
        const loopLen = this.originalCum[this.originalCum.length - 1];
        const rejoinAt = Math.min(loopLen - 50, doneOnOriginal + Math.max(300, loopLen * 0.1));
        if (rejoinAt <= doneOnOriginal) return false;
        const rejoin = pointAtDistance(this.original, this.originalCum, rejoinAt);
        const back = await api.getDirections(from, rejoin);
        if (back.points.length < 2) return false;
        const rest = this.original.filter((_, i) => this.originalCum[i] > rejoinAt);
        points = [...back.points, rejoin, ...rest];
      } else {
        const finish = this.original[this.original.length - 1];
        const dir = await api.getDirections(from, finish);
        if (dir.points.length < 2) return false;
        points = [...dir.points, finish];
      }
      this.active = points;
      this.cum = cumulativeDistances(points);
      this.along = 0;
      this.offFixes = 0;
      this.reroutes += 1;
      return true;
    } catch {
      return false;
    } finally {
      this.rerouting = false;
    }
  }
}
