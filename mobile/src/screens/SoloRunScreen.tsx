import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng, SoloRun, SoloFinishResponse } from "../types";
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

type Props = NativeStackScreenProps<RootStackParamList, "SoloRun">;

// Solo is on your own clock: tap START when you're lined up, then 3-2-1-GO.
const COUNTDOWN_S = 3;
// The x / MAP row sits at the top; the HUD starts below it.
const TOP_BUTTON_ROW_H = 56;

type Phase = "locating" | "ready" | "countdown" | "running" | "saving" | "done" | "error";

// A solo sprint against the clock on a real road course -- the same course a
// head-to-head race gets (a driving route from where you are, the way you
// picked, cut to exactly the distance), just you. Your time goes down as a
// personal best for that distance and onto the worldwide time boards.
export default function SoloRunScreen({ route, navigation }: Props) {
  const { distanceKey, directionKey } = route.params;
  const { user, vehicleStyle, units } = useUser();
  const { reportPosition } = useProximityVoiceContext();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>("locating");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [run, setRun] = useState<SoloRun | null>(null);
  const [course, setCourse] = useState<LatLng[] | null>(null);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [countdownS, setCountdownS] = useState(COUNTDOWN_S);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [result, setResult] = useState<SoloFinishResponse | null>(null);

  const mapRef = useRef<MapView | null>(null);
  const runRef = useRef<SoloRun | null>(null);
  const phaseRef = useRef<Phase>("locating");
  const courseRef = useRef<LatLng[] | null>(null);
  const courseCumRef = useRef<number[]>([]);
  const targetRef = useRef(0);
  const startedAtRef = useRef(0);
  const startPointRef = useRef<LatLng | null>(null);
  const distanceRef = useRef(0);
  const maxSpeedRef = useRef(0);
  const finishedRef = useRef(false);
  const presencePosRef: PresencePositionRef = useRef(null);
  usePresenceHeartbeat(presencePosRef);
  const markFix = useStaleSpeedReset(() => setSpeedKmh(0));

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // ---- set-up: where are you, and lay out the course from there ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== "granted") throw new Error("Location permission is needed to lay out your course.");
        let loc = await Location.getLastKnownPositionAsync({});
        if (!loc || Date.now() - loc.timestamp > 60000) {
          loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        }
        const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        if (cancelled) return;
        setMyPos(pos);
        presencePosRef.current = { coords: pos, heading: null };

        const created = await api.createSoloRun(user.deviceId, distanceKey, directionKey, pos);
        if (cancelled) {
          api.abandonSoloRun(created.id, user.deviceId).catch(() => {});
          return;
        }
        runRef.current = created;
        setRun(created);
        targetRef.current = created.courseDistanceM || created.distanceM;
        if (created.course && created.course.length >= 2) {
          courseRef.current = created.course;
          courseCumRef.current = cumulativeDistances(created.course);
          setCourse(created.course);
        }
        go("ready");
      } catch (e: any) {
        if (cancelled) return;
        setErrorText(e.message || "Couldn't set up the run.");
        go("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Show the whole course while you line up.
  useEffect(() => {
    if (!course || course.length < 2) return;
    const t = setTimeout(() => {
      mapRef.current?.fitToCoordinates(
        course.map((p) => ({ latitude: p.lat, longitude: p.lng })),
        { edgePadding: { top: 260, right: 60, bottom: 220, left: 60 }, animated: true }
      );
    }, 400);
    return () => clearTimeout(t);
  }, [course]);

  // Never leave GPS running, or an unfinished run on the server, behind.
  useEffect(() => {
    return () => {
      // Also stops a countdown that's still ticking.
      phaseRef.current = "done";
      stopBackgroundTracking("solo");
      const r = runRef.current;
      if (r && !finishedRef.current && user) api.abandonSoloRun(r.id, user.deviceId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- GPS -----------------------------------------------------------------
  const handleLocationPoints = (points: BackgroundLocationPoint[]) => {
    if (points.length === 0 || finishedRef.current) return;
    const last = points[points.length - 1];
    const pos = { lat: last.lat, lng: last.lng };
    setMyPos(pos);
    if (last.heading != null) setHeading(last.heading);
    presencePosRef.current = { coords: pos, heading: last.heading ?? null };
    reportPosition(pos, last.heading ?? null);
    setSpeedKmh(last.speedKmh);
    markFix();
    recordSpeed(last.speedKmh);

    // Before GO the GPS is just warming up -- nothing counts yet.
    if (phaseRef.current !== "running") return;

    mapRef.current?.animateToRegion(
      { latitude: pos.lat, longitude: pos.lng, latitudeDelta: 0.006, longitudeDelta: 0.006 },
      500
    );
    if (last.speedKmh > maxSpeedRef.current) maxSpeedRef.current = last.speedKmh;
    if (courseRef.current && courseRef.current.length >= 2) {
      // How far down the course road you are, kept monotonic so GPS wobble
      // can't take back road you've already driven.
      const { distanceAlongM } = projectOntoPolyline(courseRef.current, courseCumRef.current, pos);
      distanceRef.current = Math.max(distanceRef.current, distanceAlongM);
    } else {
      // No road course: progress along the chosen compass direction.
      if (!startPointRef.current) startPointRef.current = { lat: points[0].lat, lng: points[0].lng };
      distanceRef.current = Math.max(0, directionalProgressM(startPointRef.current, pos, directionKey));
    }
    setDistanceM(distanceRef.current);
    setElapsedMs(Date.now() - startedAtRef.current);
    if (distanceRef.current >= targetRef.current) finishRun(true);
  };

  // HUD clock ticks smoothly between GPS fixes.
  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
    return () => clearInterval(t);
  }, [phase]);

  // ---- start / countdown ---------------------------------------------------
  const onStart = async () => {
    if (phaseRef.current !== "ready") return;
    const bg = await requestBackgroundLocationPermission();
    if (!bg) {
      Alert.alert(
        "Background location not granted",
        'Timing will pause if you lock your phone mid-run. For an uninterrupted run, allow location "All the time" in Settings.'
      );
    }
    // Warm the GPS up during the countdown so the first fix after GO is fresh.
    setBackgroundLocationListener(handleLocationPoints, "solo");
    await startBackgroundTracking(`Solo ${run?.distanceLabel ?? ""} run -- tap to return to Phantom Racing.`, "solo");
    go("countdown");
    let left = COUNTDOWN_S;
    setCountdownS(left);
    const t = setInterval(() => {
      if (phaseRef.current !== "countdown") {
        clearInterval(t);
        return;
      }
      left -= 1;
      if (left > 0) {
        setCountdownS(left);
        return;
      }
      clearInterval(t);
      setCountdownS(0);
      startedAtRef.current = Date.now();
      distanceRef.current = 0;
      maxSpeedRef.current = 0;
      startPointRef.current = null;
      go("running");
    }, 1000);
  };

  // ---- finish ----------------------------------------------------------------
  const finishRun = async (reachedLine: boolean) => {
    const r = runRef.current;
    if (finishedRef.current || !r || !user) return;
    finishedRef.current = true;
    go("saving");
    await stopBackgroundTracking("solo");
    flushTopSpeed();
    const durationMs = Math.max(1, Date.now() - startedAtRef.current);
    const covered = reachedLine ? Math.max(distanceRef.current, targetRef.current) : distanceRef.current;
    const avg = covered / 1000 / (durationMs / 3600000);
    try {
      const res = await api.finishSoloRun(r.id, user.deviceId, durationMs, covered, avg, maxSpeedRef.current);
      setResult(res);
      go("done");
    } catch (e: any) {
      setErrorText(e.message || "Couldn't save your run.");
      go("error");
    }
  };

  const onEndRun = () => {
    const remaining = Math.max(0, targetRef.current - distanceRef.current);
    if (remaining <= 0) {
      finishRun(true);
      return;
    }
    Alert.alert(
      "End the run here?",
      `You're ${formatDistanceShort(remaining, units)} short of the finish, so it won't count as a time -- the driving still counts toward your stats.`,
      [
        { text: "Keep going", style: "cancel" },
        { text: "End run", style: "destructive", onPress: () => finishRun(false) },
      ]
    );
  };

  const openMenu = () => {
    flushTopSpeed();
    navigation.push("Home", { busy: { kind: "solo", label: `Solo ${run?.distanceLabel ?? ""} run` } });
  };

  const onClose = () => {
    if (phaseRef.current === "running") {
      Alert.alert("Leave the run?", "You can look at the map without ending it.", [
        { text: "Keep going", style: "cancel" },
        { text: "Map (keep running)", onPress: openMenu },
        { text: "End run", style: "destructive", onPress: onEndRun },
      ]);
      return;
    }
    // Anything before GO (or after the result) just leaves; unmount cleans up.
    navigation.goBack();
  };

  const runAgain = () => navigation.replace("SoloRun", { distanceKey, directionKey });

  // ---- render --------------------------------------------------------------
  if (phase === "locating" || phase === "error") {
    return (
      <View style={styles.centered}>
        {phase === "locating" ? (
          <>
            <ActivityIndicator color={colors.cyan} size="large" />
            <Text style={styles.centeredText}>Laying out your course...</Text>
          </>
        ) : (
          <>
            <Text style={styles.errorText}>{errorText}</Text>
            <NeonButton label="BACK" onPress={() => navigation.goBack()} style={styles.centeredButton} />
          </>
        )}
      </View>
    );
  }

  const target = targetRef.current || run?.distanceM || 0;
  const progressPct = target > 0 ? Math.min(1, distanceM / target) : 0;
  const label = `${run?.distanceLabel ?? ""} ${run?.directionLabel ?? ""}`.trim();

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={
          myPos
            ? { latitude: myPos.lat, longitude: myPos.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 }
            : undefined
        }
      >
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

      <Pressable style={[styles.topButton, { top: insets.top + 10, left: 16, width: 36 }]} onPress={onClose} hitSlop={10}>
        <Text style={styles.topButtonText}>x</Text>
      </Pressable>
      {phase === "running" && (
        <Pressable style={[styles.topButton, { top: insets.top + 10, left: 60, paddingHorizontal: 12 }]} onPress={openMenu} hitSlop={10}>
          <Text style={styles.topButtonText}>MAP</Text>
        </Pressable>
      )}

      {/* Lined up, waiting for you to go. */}
      {phase === "ready" && (
        <View style={[styles.hud, { top: insets.top + TOP_BUTTON_ROW_H }]}>
          <Text style={styles.hudLabel}>SOLO RUN</Text>
          <Text style={styles.hudTitle}>{label}</Text>
          <Text style={styles.hudHint}>
            {course
              ? "Line up at the start of the gold line, then tap START. Your time runs from GO to the FINISH."
              : `No road course could be laid out here -- after GO, just head ${run?.directionLabel ?? "straight"} for the full distance.`}
          </Text>
        </View>
      )}

      {phase === "countdown" && (
        <View style={styles.countdownOverlay}>
          <Text style={styles.countdownLabel}>{label}</Text>
          <Text style={styles.countdownNumber}>{countdownS > 0 ? countdownS : "GO"}</Text>
        </View>
      )}

      {(phase === "running" || phase === "saving") && (
        <View style={[styles.hud, { top: insets.top + TOP_BUTTON_ROW_H }]}>
          <Text style={styles.hudLabel} numberOfLines={1}>
            SOLO {label}
          </Text>
          <Text style={styles.time}>{formatDuration(elapsedMs)}</Text>
          <Text style={styles.speed}>
            {displaySpeedKmh(speedKmh, units)} {speedUnit(units)}
            {"   "}
            <Text style={styles.remaining}>{formatDistanceShort(Math.max(0, target - distanceM), units)} to go</Text>
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressPct * 100}%` }]} />
          </View>
          {phase === "saving" && (
            <View style={styles.savingRow}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.savingText}>Saving your time...</Text>
            </View>
          )}
        </View>
      )}

      {phase === "done" && result && (
        <View style={[styles.resultCard, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.hudLabel}>SOLO {label}</Text>
          {result.counted && result.result ? (
            <>
              <Text style={styles.resultTime}>{formatDuration(result.result.durationMs)}</Text>
              {result.isPersonalBest ? (
                <Text style={styles.pb}>NEW PERSONAL BEST</Text>
              ) : result.previousBestMs != null ? (
                <Text style={styles.resultMeta}>Your best: {formatDuration(result.previousBestMs)}</Text>
              ) : null}
              {result.worldRank != null && (
                <Text style={styles.resultMeta}>
                  #{result.worldRank} in the world at {result.distanceLabel}
                </Text>
              )}
            </>
          ) : (
            <>
              <Text style={styles.resultTimeMuted}>RUN ENDED</Text>
              <Text style={styles.resultMeta}>
                Stopped short of the finish, so no time this run -- the driving still counts toward your stats.
              </Text>
            </>
          )}
          {result.result && (
            <Text style={styles.resultDetail}>
              avg {displaySpeedKmh(result.result.avgSpeedKmh, units)} {speedUnit(units)} -- top{" "}
              {displaySpeedKmh(result.result.maxSpeedKmh, units)} {speedUnit(units)}
            </Text>
          )}
          <View style={styles.actionsRow}>
            <NeonButton label="RUN IT AGAIN" onPress={runAgain} style={styles.actionButton} />
            <NeonButton label="DONE" variant="outline" onPress={() => navigation.goBack()} style={styles.actionButton} />
          </View>
        </View>
      )}

      {phase === "ready" && (
        <NeonButton label="START" onPress={onStart} style={[styles.bottomButton, { bottom: insets.bottom + 24 }]} />
      )}
      {phase === "running" && (
        <NeonButton
          label="END RUN"
          variant="outline"
          onPress={onEndRun}
          style={[styles.bottomButton, { bottom: insets.bottom + 24 }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  centeredText: { color: colors.textSecondary, fontSize: 14, marginTop: 14 },
  centeredButton: { marginTop: 20, width: 200 },
  errorText: { color: colors.danger, fontSize: 14, fontWeight: "600", textAlign: "center" },
  topButton: {
    position: "absolute",
    height: 36,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  topButtonText: { color: colors.cyan, fontSize: 13, fontWeight: "800", letterSpacing: 1 },
  hud: { position: "absolute", left: 20, right: 20, ...panelStyle, padding: 16 },
  hudLabel: { color: colors.textSecondary, fontSize: 12, textAlign: "center", letterSpacing: 1 },
  hudTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 20, textAlign: "center", marginTop: 4 },
  hudHint: { color: colors.textSecondary, fontSize: 13, textAlign: "center", marginTop: 8 },
  time: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 40, textAlign: "center", marginTop: 4 },
  speed: { color: colors.textSecondary, fontSize: 14, textAlign: "center", marginTop: 6 },
  remaining: { color: colors.gold, fontSize: 13 },
  progressTrack: { height: 8, backgroundColor: colors.bgElevated, borderRadius: 4, marginTop: 12, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: colors.gold },
  savingRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 12, gap: 8 },
  savingText: { color: colors.cyan, fontSize: 13, fontWeight: "600" },
  countdownOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#05070ccc",
  },
  countdownLabel: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 18, letterSpacing: 2, marginBottom: 20 },
  countdownNumber: { color: colors.racePrimary, fontFamily: fonts.display, fontSize: 96 },
  finishPin: {
    backgroundColor: "#000000dd",
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.gold,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  finishPinText: { color: colors.gold, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  resultCard: { position: "absolute", left: 16, right: 16, ...panelStyle, padding: 18, alignItems: "center" },
  resultTime: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 44, marginTop: 6 },
  resultTimeMuted: { color: colors.textMuted, fontFamily: fonts.display, fontSize: 28, marginTop: 6 },
  pb: { color: colors.gold, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 2, marginTop: 6 },
  resultMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 6, textAlign: "center" },
  resultDetail: { color: colors.textMuted, fontSize: 12, marginTop: 10 },
  actionsRow: { flexDirection: "row", gap: 10, marginTop: 16, alignSelf: "stretch" },
  actionButton: { flex: 1 },
  bottomButton: { position: "absolute", left: 20, right: 20 },
});
