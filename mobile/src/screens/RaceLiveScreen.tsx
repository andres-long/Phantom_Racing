import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, Region } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng, RaceChallenge, RaceProgress } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { useProximityVoiceContext } from "../context/ProximityVoiceContext";
import { formatDuration, cumulativeDistances, projectOntoPolyline } from "../utils/geo";
import { displaySpeedKmh, speedUnit, formatDistanceShort } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
import NeonButton from "../components/NeonButton";
import VehicleMarker from "../components/VehicleMarker";
import {
  BackgroundLocationPoint,
  requestBackgroundLocationPermission,
  setBackgroundLocationListener,
  startBackgroundTracking,
  stopBackgroundTracking,
} from "../backgroundLocation";
import { usePresenceHeartbeat, PresencePositionRef } from "../hooks/usePresenceHeartbeat";
import { directionalProgressM } from "../raceDirections";
import { recordSpeed, flushTopSpeed } from "../topSpeed";
import { useStaleSpeedReset } from "../utils/speed";

type Props = NativeStackScreenProps<RootStackParamList, "RaceLive">;

// The x / MAP buttons sit in a row at the top; the HUD starts below them
// instead of being drawn over them (they used to peek out from behind it).
const TOP_BUTTON_ROW_H = 56;

// How often to push our own progress (and, via the same response, pick up
// the opponent's) to the backend while the race is live.
const PROGRESS_INTERVAL_MS = 2000;

const FALLBACK_REGION: Region = {
  latitude: 14.6349,
  longitude: -90.5069,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

// The live head-to-head race screen: a synced countdown (server-issued, so
// both racers start at the same instant regardless of network latency),
// then a HUD comparing your own progress toward the target distance against
// your opponent's, on whatever road you're actually on -- there's no
// predefined shared route, just each racer's own GPS trace measured against
// the same fixed target (see raceDistances.ts / RACE_DISTANCES on the
// backend). First to cover the target distance finishes; RaceResultScreen
// shows who was faster.
export default function RaceLiveScreen({ route, navigation }: Props) {
  const { raceId } = route.params;
  const { user, vehicleStyle, units } = useUser();
  const { reportPosition } = useProximityVoiceContext();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<"loading" | "countdown" | "racing" | "ending">("loading");
  const [race, setRace] = useState<RaceChallenge | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [countdownS, setCountdownS] = useState<number | null>(null);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [trace, setTrace] = useState<LatLng[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [distanceCoveredM, setDistanceCoveredM] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [opponentProgress, setOpponentProgress] = useState<RaceProgress | null>(null);

  const mapRef = useRef<MapView | null>(null);
  const distanceCoveredRef = useRef(0);
  const speedKmhRef = useRef(0);
  const lastPointRef = useRef<LatLng | null>(null);
  const maxSpeedRef = useRef(0);
  const actualStartRef = useRef<number>(0);
  // How far this phone's clock is from the server's (server - phone, ms).
  // Two phones' clocks can easily be a couple of seconds apart, and the
  // countdown used to run on each phone's own clock -- so the two racers
  // saw GO about two seconds apart. Everything race-timing now runs on the
  // server's clock instead (see sampleClockOffset).
  const clockOffsetRef = useRef(0);
  const bestRttRef = useRef(Number.POSITIVE_INFINITY);
  const serverNow = () => Date.now() + clockOffsetRef.current;
  const finishedRef = useRef(false);
  const targetDistanceRef = useRef(0);
  // Where we were when the countdown hit zero, and which way this race
  // runs: progress is how far we've got from that point in that direction,
  // so both racers are running the same race and doubling back doesn't
  // score (see raceDirections.ts).
  const startPointRef = useRef<LatLng | null>(null);
  const directionRef = useRef<"north" | "east" | "south" | "west">("north");
  // The road course, when the backend managed to lay one out: an actual
  // driving route the chosen way, cut to exactly the chosen distance. With
  // one, progress is how far along that road you are (which keeps counting
  // through its turns); without one, it falls back to the compass axis.
  const [course, setCourse] = useState<LatLng[] | null>(null);
  const courseRef = useRef<LatLng[] | null>(null);
  const courseCumRef = useRef<number[]>([]);
  const presencePosRef: PresencePositionRef = useRef(null);
  usePresenceHeartbeat(presencePosRef);
  // Speed back to 0 once fixes stop arriving (you've stopped moving).
  const markFix = useStaleSpeedReset(() => {
    setSpeedKmh(0);
    speedKmhRef.current = 0;
  });

  // A one-off fix so the map has somewhere to center before tracking starts
  // (mirrors RecordRunScreen's own pre-start fix) -- best-effort, the
  // permission request that actually matters happens once racing begins.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setMyPos({ lat: loc.coords.latitude, lng: loc.coords.longitude });
        if (loc.coords.heading != null && loc.coords.heading >= 0) setHeading(loc.coords.heading);
      } catch {
        // No fix yet -- the marker just won't show until tracking starts.
      }
    })();
  }, []);

  // Show the whole course while the countdown runs, so you can see where
  // you're going before you're going there. Once racing starts the
  // follow-cam takes the map back over.
  useEffect(() => {
    if (!course || course.length < 2) return;
    const t = setTimeout(() => {
      mapRef.current?.fitToCoordinates(
        course.map((p) => ({ latitude: p.lat, longitude: p.lng })),
        { edgePadding: { top: 140, right: 60, bottom: 220, left: 60 }, animated: true }
      );
    }, 400);
    return () => clearTimeout(t);
  }, [course]);

  // One clock sample: the server's time at the middle of a round trip vs
  // ours. The quickest round trip gives the tightest estimate, so only a
  // faster sample replaces an earlier one.
  const sampleClockOffset = (serverNowMs: number | undefined, sentAt: number, receivedAt: number) => {
    if (!serverNowMs || !Number.isFinite(serverNowMs)) return;
    const rtt = receivedAt - sentAt;
    if (rtt >= bestRttRef.current) return;
    bestRttRef.current = rtt;
    clockOffsetRef.current = serverNowMs - (sentAt + receivedAt) / 2;
  };

  // Loads the race once on mount: target distance, opponent name, and the
  // server-issued raceStartAt both sides count down from together.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      try {
        const sentAt = Date.now();
        const r = await api.getRaceChallenge(raceId, user.deviceId);
        sampleClockOffset(r.serverNow, sentAt, Date.now());
        if (cancelled) return;
        if (r.status !== "accepted" && r.status !== "finished") {
          setLoadError("This race is no longer active.");
          return;
        }
        targetDistanceRef.current = r.courseDistanceM || r.distanceM;
        directionRef.current = r.directionKey || "north";
        if (r.course && r.course.length >= 2) {
          courseRef.current = r.course;
          courseCumRef.current = cumulativeDistances(r.course);
          setCourse(r.course);
        }
        setRace(r);
        setPhase("countdown");
        // A few more clock samples during the countdown -- a single request
        // can be slowed by a busy network, and the fastest one wins.
        for (let i = 0; i < 3 && !cancelled; i++) {
          try {
            const sent = Date.now();
            const again = await api.getRaceChallenge(raceId, user.deviceId);
            sampleClockOffset(again.serverNow, sent, Date.now());
          } catch {
            // Keep whatever estimate we already have.
          }
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(e.message || "Couldn't load the race.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [raceId, user]);

  // Counts down to raceStartAt, then flips to "racing" and kicks off
  // tracking. Reads the clock directly rather than trusting a fixed
  // 5-second timer, so a screen that took a moment to mount still lands on
  // the same wall-clock instant as the opponent's device.
  useEffect(() => {
    if (phase !== "countdown" || !race?.raceStartAt) return;
    const startAt = new Date(race.raceStartAt).getTime();
    let cancelled = false;
    let t: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      // On the server's clock, so both phones hit GO together.
      const msLeft = startAt - serverNow();
      if (msLeft <= 0) {
        if (cancelled) return;
        setCountdownS(0);
        // The start instant itself (in this phone's clock), not whenever
        // this 200ms tick happened to notice it -- both racers' times are
        // measured from the same moment.
        actualStartRef.current = startAt - clockOffsetRef.current;
        setPhase("racing");
        if (t) clearInterval(t);
        return;
      }
      setCountdownS(Math.ceil(msLeft / 1000));
    };

    tick();
    t = setInterval(tick, 200);
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [phase, race?.raceStartAt]);

  // What you actually drove so far, for whichever way this race ends. Until
  // the countdown hits zero there's no race yet, so it's all zeroes.
  const raceSoFar = () => {
    const started = actualStartRef.current > 0;
    const durationMs = started ? Math.max(1, Date.now() - actualStartRef.current) : 0;
    const distanceM = started ? distanceCoveredRef.current : 0;
    return {
      durationMs,
      distanceM,
      avgSpeedKmh: durationMs > 0 ? distanceM / 1000 / (durationMs / 3600000) : 0,
      maxSpeedKmh: maxSpeedRef.current,
    };
  };

  const finishRace = async (finalDistanceM: number) => {
    if (finishedRef.current || !user) return;
    finishedRef.current = true;
    setPhase("ending");
    await stopBackgroundTracking("race");
    flushTopSpeed();
    const durationMs = Math.max(1, Date.now() - actualStartRef.current);
    const avgSpeedKmh = finalDistanceM / 1000 / (durationMs / 3600000);
    try {
      await api.finishRace(raceId, user.deviceId, durationMs, finalDistanceM, avgSpeedKmh, maxSpeedRef.current);
    } catch {
      // Even if this particular call fails, still take them to the result
      // screen -- it re-fetches the race itself rather than trusting this
      // response, so a dropped finish call isn't a dead end.
    }
    navigation.replace("RaceResult", { raceId });
  };

  // Ending the race by hand. If you've already covered the distance (GPS
  // just hadn't caught up to trigger the auto-finish) that's a normal
  // finish; anywhere short of the line it's a forfeit -- the other racer
  // wins. Ending it yourself is never a way to win it.
  const onEndRace = () => {
    if (finishedRef.current) return;
    const remainingM = Math.max(0, targetDistanceRef.current - distanceCoveredRef.current);
    if (remainingM <= 0) {
      finishRace(distanceCoveredRef.current);
      return;
    }
    Alert.alert(
      "End the race here?",
      `You're ${formatDistanceShort(remainingM, units)} short of the finish, so ending now is a forfeit -- ${
        race?.opponentDisplayName ?? "the other racer"
      } wins. The distance you drove still counts toward your stats.`,
      [
        { text: "Keep racing", style: "cancel" },
        { text: "End race (forfeit)", style: "destructive", onPress: forfeit },
      ]
    );
  };

  // Dropping out: the other racer takes the win right away (they don't have
  // to keep driving to collect it), and the distance you did cover still
  // counts toward your own stats.
  const forfeit = async () => {
    if (finishedRef.current || !user) return;
    finishedRef.current = true;
    setPhase("ending");
    await stopBackgroundTracking("race");
    flushTopSpeed();
    const { durationMs, distanceM, avgSpeedKmh, maxSpeedKmh } = raceSoFar();
    try {
      await api.forfeitRace(raceId, user.deviceId, durationMs, distanceM, avgSpeedKmh, maxSpeedKmh);
    } catch {
      // Same as finishing: the result screen re-fetches the race itself.
    }
    navigation.replace("RaceResult", { raceId });
  };

  // The map/menu opens on top of this screen instead of replacing it, so
  // the race keeps running underneath -- still timing, still tracking,
  // still reporting your progress to your opponent. Home shows a banner
  // saying so, and going back drops you straight back into the race.
  const openMenu = () => {
    flushTopSpeed();
    navigation.push("Home", {
      busy: { kind: "race", label: `Racing ${race?.opponentDisplayName ?? "another driver"}` },
    });
  };

  // Fed by the background-capable location task (same as RecordRun/GoRace)
  // so tracking survives a screen lock mid-race. Each batch folds into our
  // running distance-covered total and, once that crosses the target,
  // triggers the finish.
  const handleLocationPoints = (points: BackgroundLocationPoint[]) => {
    if (points.length === 0 || finishedRef.current) return;
    const last = points[points.length - 1];
    const pos = { lat: last.lat, lng: last.lng };

    setMyPos(pos);
    if (last.heading != null) setHeading(last.heading);
    presencePosRef.current = { coords: pos, heading: last.heading ?? null };
    reportPosition(pos, last.heading ?? null);
    mapRef.current?.animateToRegion(
      { latitude: pos.lat, longitude: pos.lng, latitudeDelta: 0.012, longitudeDelta: 0.012 },
      500
    );
    setSpeedKmh(last.speedKmh);
    speedKmhRef.current = last.speedKmh;
    markFix();
    recordSpeed(last.speedKmh);
    if (last.speedKmh > maxSpeedRef.current) {
      maxSpeedRef.current = last.speedKmh;
    }

    // The first fix after the countdown is the start line.
    if (!startPointRef.current) {
      startPointRef.current = { lat: points[0].lat, lng: points[0].lng };
    }
    lastPointRef.current = pos;
    if (courseRef.current && courseRef.current.length >= 2) {
      // How far down the course road you've got. Kept monotonic so a GPS
      // wobble (or a course that doubles back near itself) can't take
      // distance back off you once you've driven it.
      const { distanceAlongM } = projectOntoPolyline(courseRef.current, courseCumRef.current, pos);
      distanceCoveredRef.current = Math.max(distanceCoveredRef.current, distanceAlongM);
    } else {
      // No course: the compass axis. Never below zero, so driving the wrong
      // way just leaves you at the line rather than digging a hole you have
      // to climb back out of.
      distanceCoveredRef.current = Math.max(
        0,
        directionalProgressM(startPointRef.current, pos, directionRef.current)
      );
    }
    setDistanceCoveredM(distanceCoveredRef.current);
    setTrace((prev) => [...prev, ...points.map((p) => ({ lat: p.lat, lng: p.lng }))]);
    setElapsedMs(Date.now() - actualStartRef.current);

    if (distanceCoveredRef.current >= targetDistanceRef.current) {
      finishRace(distanceCoveredRef.current);
    }
  };

  // Starts tracking the instant the countdown hits zero.
  useEffect(() => {
    if (phase !== "racing") return;
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location permission needed", "Can't race without location access.", [
          { text: "OK", onPress: () => navigation.goBack() },
        ]);
        return;
      }
      await requestBackgroundLocationPermission();
      if (cancelled) return;
      lastPointRef.current = null;
      startPointRef.current = null;
      distanceCoveredRef.current = 0;
      setBackgroundLocationListener(handleLocationPoints, "race");
      await startBackgroundTracking(`Racing ${race?.opponentDisplayName ?? "another driver"} -- tap to return to Phantom Racing.`, "race");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Pushes our own progress (and picks up the opponent's) every couple of
  // seconds while racing. A specific "not currently active" error means the
  // race itself ended on the other side (opponent bailed); anything else is
  // treated as a transient network hiccup and just retried next tick.
  useEffect(() => {
    if (phase !== "racing" || !user) return;
    let cancelled = false;
    const tick = async () => {
      if (finishedRef.current) return;
      try {
        const updated = await api.postRaceProgress(
          raceId,
          user.deviceId,
          distanceCoveredRef.current,
          Date.now() - actualStartRef.current,
          speedKmhRef.current
        );
        if (cancelled) return;
        setOpponentProgress(updated.opponentProgress);
      } catch (e: any) {
        if (cancelled || finishedRef.current) return;
        if (e.message === "This race isn't currently active.") {
          // The other racer crossed the line, finished by hand, or bailed.
          // Either way this race is over for us too -- go and see how it
          // ended rather than sitting here driving a decided race.
          finishedRef.current = true;
          await stopBackgroundTracking("race");
          flushTopSpeed();
          try {
            const ended = await api.getRaceChallenge(raceId, user.deviceId);
            if (ended.status === "finished") {
              navigation.replace("RaceResult", { raceId });
              return;
            }
          } catch {
            // Couldn't check -- fall through to the generic message.
          }
          Alert.alert("Race ended", `${race?.opponentDisplayName ?? "The other racer"} left the race.`, [
            { text: "OK", onPress: () => navigation.goBack() },
          ]);
        }
      }
    };
    const t = setInterval(tick, PROGRESS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, raceId, user]);

  // Belt-and-suspenders: whatever happens (unmount mid-race, navigating
  // away some other way), never leave the background location task running.
  useEffect(() => {
    return () => {
      stopBackgroundTracking("race");
    };
  }, []);

  const onBail = () => {
    Alert.alert(
      "Leave the race?",
      "You can look at the map without ending it -- the race keeps running while you're there.",
      [
        { text: "Keep racing", style: "cancel" },
        { text: "Map (keep racing)", onPress: openMenu },
        {
          text: `Forfeit -- ${race?.opponentDisplayName ?? "they"} win`,
          style: "destructive",
          onPress: forfeit,
        },
      ]
    );
  };

  if (loadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{loadError}</Text>
        <NeonButton label="BACK" onPress={() => navigation.goBack()} style={styles.errorButton} />
      </View>
    );
  }

  if (phase === "loading" || !race) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  const targetM = race.distanceM;
  const myProgressPct = targetM > 0 ? Math.min(1, distanceCoveredM / targetM) : 0;
  const opponentProgressPct =
    targetM > 0 && opponentProgress ? Math.min(1, opponentProgress.distanceM / targetM) : 0;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={
          myPos
            ? { latitude: myPos.lat, longitude: myPos.lng, latitudeDelta: 0.012, longitudeDelta: 0.012 }
            : FALLBACK_REGION
        }
      >
        {/* The course: the road to drive, and where it ends. */}
        {course && course.length >= 2 && (
          <>
            <Polyline
              coordinates={course.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
              strokeColor={colors.gold}
              strokeWidth={7}
            />
            <Marker
              coordinate={{ latitude: course[course.length - 1].lat, longitude: course[course.length - 1].lng }}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={styles.finishPin}>
                <Text style={styles.finishPinText}>FINISH</Text>
              </View>
            </Marker>
          </>
        )}
        {trace.length >= 2 && (
          <Polyline
            coordinates={trace.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
            strokeColor={colors.racePrimary}
            strokeWidth={4}
          />
        )}
        {myPos && (
          <Marker
            coordinate={{ latitude: myPos.lat, longitude: myPos.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={heading}
            flat
            tracksViewChanges={false}
          >
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
      </MapView>

      <Pressable style={[styles.cancelButton, { top: insets.top + 10 }]} onPress={onBail} hitSlop={10}>
        <Text style={styles.cancelText}>x</Text>
      </Pressable>

      {/* Straight to the map, without ending the race. */}
      <Pressable style={[styles.menuButton, { top: insets.top + 10 }]} onPress={openMenu} hitSlop={10}>
        <Text style={styles.menuButtonText}>MAP</Text>
      </Pressable>

      {phase === "countdown" && (
        <View style={styles.countdownOverlay}>
          <Text style={styles.countdownVs}>VS {race.opponentDisplayName.toUpperCase()}</Text>
          <Text style={styles.countdownDistance}>
            {race.distanceLabel} {race.directionLabel}
          </Text>
          <Text style={styles.countdownNumber}>{countdownS && countdownS > 0 ? countdownS : "GO"}</Text>
          <Text style={styles.countdownHint}>
            {course ? "Follow the gold line to the finish" : "No road course -- just head " + race.directionLabel}
          </Text>
        </View>
      )}

      {(phase === "racing" || phase === "ending") && (
        <View style={[styles.hud, { top: insets.top + TOP_BUTTON_ROW_H }]}>
          <Text style={styles.raceLabel} numberOfLines={1}>
            {race.distanceLabel} {race.directionLabel} VS {race.opponentDisplayName}
          </Text>
          {course && <Text style={styles.courseHint}>Follow the gold line</Text>}
          <Text style={styles.time}>{formatDuration(elapsedMs)}</Text>
          <Text style={styles.speed}>
            {displaySpeedKmh(speedKmh, units)} {speedUnit(units)}
          </Text>

          <View style={styles.progressBlock}>
            <Text style={styles.progressLabel}>YOU</Text>
            <View style={styles.progressTrack}>
              <View
                style={[styles.progressFill, { width: `${myProgressPct * 100}%`, backgroundColor: colors.cyan }]}
              />
            </View>
          </View>
          <View style={styles.progressBlock}>
            <Text style={styles.progressLabel} numberOfLines={1}>
              {race.opponentDisplayName.toUpperCase()}
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${opponentProgressPct * 100}%`, backgroundColor: colors.racePrimary },
                ]}
              />
            </View>
          </View>

          {phase === "ending" && (
            <View style={styles.endingRow}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.endingText}>Finishing...</Text>
            </View>
          )}
        </View>
      )}

      {/* Always a way out that isn't "keep driving until the distance is
          done": end it here and keep your time, or hand them the win. */}
      {phase === "racing" && (
        <View style={[styles.raceActions, { bottom: insets.bottom + 24 }]}>
          <NeonButton label="END RACE" variant="outline" onPress={onEndRace} style={styles.raceActionButton} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: colors.danger, fontSize: 14, fontWeight: "600", textAlign: "center" },
  errorButton: { marginTop: 20, width: 200 },
  cancelButton: {
    position: "absolute",
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: colors.cyan, fontSize: 16, fontWeight: "800" },
  menuButton: {
    position: "absolute",
    left: 60,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  raceActions: {
    position: "absolute",
    left: 20,
    right: 20,
    flexDirection: "row",
    gap: 12,
  },
  raceActionButton: { flex: 1 },
  countdownOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#05070ccc",
  },
  countdownVs: { color: colors.textSecondary, fontSize: 14, letterSpacing: 1, marginBottom: 4 },
  countdownDistance: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 18, letterSpacing: 2, marginBottom: 20 },
  countdownNumber: { color: colors.racePrimary, fontFamily: fonts.display, fontSize: 96 },
  countdownHint: { color: colors.textSecondary, fontSize: 13, marginTop: 16, textAlign: "center", paddingHorizontal: 30 },
  courseHint: { color: colors.gold, fontSize: 11, textAlign: "center", marginTop: 2, letterSpacing: 0.5 },
  finishPin: {
    backgroundColor: "#000000dd",
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.gold,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  finishPinText: { color: colors.gold, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  hud: {
    position: "absolute",
    left: 20,
    right: 20,
    ...panelStyle,
    padding: 16,
  },
  raceLabel: { color: colors.textSecondary, fontSize: 12, textAlign: "center", marginBottom: 4, letterSpacing: 0.5 },
  time: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 38, textAlign: "center" },
  speed: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: 6, marginBottom: 12 },
  progressBlock: { marginTop: 8 },
  progressLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 1, marginBottom: 3 },
  progressTrack: { height: 8, backgroundColor: colors.bgElevated, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4 },
  endingRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 14, gap: 8 },
  endingText: { color: colors.cyan, fontSize: 13, fontWeight: "600" },
});
