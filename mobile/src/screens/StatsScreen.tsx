import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, Pressable, RefreshControl } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  RootStackParamList,
  GlobalStatsMetric,
  GlobalStatsResponse,
  GlobalStatsEntry,
  SoloStatsResponse,
  RaceDistanceKey,
  SoloShape,
} from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { knownTopSpeedKmh } from "../topSpeed";
import { displaySpeedKmh, speedUnit, formatDistanceShort } from "../utils/units";
import { formatDuration } from "../utils/geo";
import { RACE_DISTANCES } from "../raceDistances";
import { colors, fonts, panelStyle } from "../theme";
import GridBackground from "../components/GridBackground";

type Props = NativeStackScreenProps<RootStackParamList, "Stats">;

type Totals = {
  topSpeedKmh: number;
  distanceM: number;
  avgSpeedKmh: number;
  driveCount: number;
  raceCount: number;
  raceWins: number;
};

type Tab = "mine" | "world";

const METRICS: { key: GlobalStatsMetric; label: string }[] = [
  { key: "topSpeed", label: "TOP SPEED" },
  { key: "distance", label: "DISTANCE" },
  { key: "avgSpeed", label: "AVG SPEED" },
  { key: "wins", label: "RACE WINS" },
];

// Below those: fastest solo run at any distance (lowest time ranks first),
// straight runs and loops on separate boards.
function timeMetric(shape: SoloShape, key: RaceDistanceKey): GlobalStatsMetric {
  return shape === "loop" ? `loop:${key}` : `solo:${key}`;
}

function parseTimeMetric(metric: GlobalStatsMetric): { shape: SoloShape; key: RaceDistanceKey } | null {
  const legacy: Record<string, RaceDistanceKey> = { soloQuarter: "quarter", soloMile: "mile", soloFive: "five" };
  if (legacy[metric]) return { shape: "sprint", key: legacy[metric] };
  const m = /^(solo|loop):(.+)$/.exec(metric);
  return m ? { shape: m[1] === "loop" ? "loop" : "sprint", key: m[2] as RaceDistanceKey } : null;
}

// A racer's best time for a board, from the per-distance map (with the
// original three fields as a fallback for an older backend).
function bestTimeMs(e: GlobalStatsEntry, shape: SoloShape, key: RaceDistanceKey): number | null {
  const k = shape === "loop" ? `${key}:loop` : key;
  const v = e.soloBestsMs?.[k];
  if (v != null) return v;
  if (shape === "sprint") {
    if (key === "quarter") return e.soloQuarterMs;
    if (key === "mile") return e.soloMileMs;
    if (key === "five") return e.soloFiveMs;
  }
  return null;
}

function ShapeSwitch({ shape, onChange }: { shape: SoloShape; onChange: (s: SoloShape) => void }) {
  return (
    <View style={styles.shapeSwitch}>
      {(["sprint", "loop"] as SoloShape[]).map((sh) => (
        <Pressable
          key={sh}
          style={[styles.shapeOption, shape === sh && styles.shapeOptionActive]}
          onPress={() => onChange(sh)}
        >
          <Text style={[styles.shapeText, shape === sh && styles.shapeTextActive]}>
            {sh === "loop" ? "LOOP" : "STRAIGHT"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// Two views of the same numbers. MINE: your lifetime totals across
// everything you've driven -- segment runs (racing a track), Go To trips
// (driving to a place) and finished live races all count, and top speed
// also counts plain driving with the app open, with nothing recorded at
// all; average speed is distance-weighted
// (total distance / total time), so a few long highway drives aren't
// outweighed by lots of short, slow ones. WORLD: every racer's lifetime
// totals (same definitions, computed server-side), ranked by one metric at a
// time, with your own rank shown even when you're outside the top list.
export default function StatsScreen({}: Props) {
  const [tab, setTab] = useState<Tab>("mine");

  return (
    <View style={styles.container}>
      <GridBackground />
      <View style={styles.tabRow}>
        <TabButton label="MINE" active={tab === "mine"} onPress={() => setTab("mine")} />
        <TabButton label="WORLD" active={tab === "world"} onPress={() => setTab("world")} />
      </View>
      {tab === "mine" ? <MyStats /> : <WorldStats />}
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tabButton, active && styles.tabButtonActive]} onPress={onPress}>
      <Text style={[styles.tabButtonText, active && styles.tabButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function MyStats() {
  const { user, units } = useUser();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [solo, setSolo] = useState<SoloStatsResponse | null>(null);
  const [bestShape, setBestShape] = useState<SoloShape>("sprint");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setError(null);
        // Races and the passive top speed fall back rather than failing
        // the whole screen: both are additions to what was already here,
        // and an older backend simply doesn't have those routes.
        const [runs, trips, races, top] = await Promise.all([
          api.getUserRuns(user.deviceId),
          api.getUserTrips(user.deviceId),
          api.getUserRaces(user.deviceId).catch(() => []),
          api.getTopSpeed(user.deviceId).catch(() => ({ topSpeedKmh: 0, topSpeedAt: null })),
        ]);
        const soloStats = await api.getUserSolo(user.deviceId).catch(() => null);
        setSolo(soloStats);
        const soloRuns = soloStats?.runs ?? [];

        let distanceM = 0;
        let durationMs = 0;
        let topSpeedKmh = 0;
        for (const r of runs) {
          distanceM += r.distanceM;
          durationMs += r.durationMs;
          if (r.maxSpeedKmh > topSpeedKmh) topSpeedKmh = r.maxSpeedKmh;
        }
        for (const t of trips) {
          distanceM += t.distanceM;
          durationMs += t.durationMs;
          if (t.maxSpeedKmh > topSpeedKmh) topSpeedKmh = t.maxSpeedKmh;
        }
        for (const r of races) {
          distanceM += r.distanceM;
          durationMs += r.durationMs;
          if (r.maxSpeedKmh > topSpeedKmh) topSpeedKmh = r.maxSpeedKmh;
        }
        for (const r of soloRuns) {
          distanceM += r.distanceM;
          durationMs += r.durationMs;
          if (r.maxSpeedKmh > topSpeedKmh) topSpeedKmh = r.maxSpeedKmh;
        }
        // Your fastest ever, including while you weren't recording anything
        // -- knownTopSpeedKmh() covers a best set in this session that
        // hasn't been sent to the server yet.
        topSpeedKmh = Math.max(topSpeedKmh, top.topSpeedKmh, knownTopSpeedKmh());

        setTotals({
          topSpeedKmh,
          distanceM,
          avgSpeedKmh: durationMs > 0 ? distanceM / 1000 / (durationMs / 3_600_000) : 0,
          driveCount: runs.length + trips.length + races.length + soloRuns.length,
          raceCount: races.length,
          raceWins: races.filter((r) => r.won === true).length,
        });
      } catch (e: any) {
        setError(e.message || "Couldn't reach the backend.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const formatDistance = (m: number) => formatDistanceShort(m, units);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {loading ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 40 }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : totals && (totals.driveCount > 0 || totals.topSpeedKmh > 0) ? (
        <>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>TOP SPEED</Text>
            <Text style={styles.tileValue}>{displaySpeedKmh(totals.topSpeedKmh, units)}</Text>
            <Text style={styles.tileUnit}>{speedUnit(units)}</Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>DISTANCE DRIVEN</Text>
            <Text style={styles.tileValue}>{formatDistance(totals.distanceM).split(" ")[0]}</Text>
            <Text style={styles.tileUnit}>{formatDistance(totals.distanceM).split(" ")[1]}</Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>AVERAGE SPEED</Text>
            <Text style={styles.tileValue}>{displaySpeedKmh(totals.avgSpeedKmh, units)}</Text>
            <Text style={styles.tileUnit}>{speedUnit(units)}</Text>
          </View>
          {/* Personal bests from solo runs, one line per distance --
              straight runs and loops kept apart. */}
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>BEST SOLO RUNS</Text>
            <ShapeSwitch shape={bestShape} onChange={setBestShape} />
            {RACE_DISTANCES.map((d) => {
              const bests = bestShape === "loop" ? solo?.loopBests : solo?.bests;
              const best = bests?.[d.key as RaceDistanceKey] ?? null;
              return (
                <View key={d.key} style={styles.bestRow}>
                  <Text style={styles.bestLabel}>{d.label}</Text>
                  <Text style={best ? styles.bestTime : styles.bestNone}>
                    {best ? formatDuration(best.durationMs) : "--"}
                  </Text>
                </View>
              );
            })}
          </View>
          {totals.raceCount > 0 && (
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>RACES WON</Text>
              <Text style={styles.tileValue}>{totals.raceWins}</Text>
              <Text style={styles.tileUnit}>of {totals.raceCount}</Text>
            </View>
          )}
          <Text style={styles.footnote}>
            {totals.driveCount > 0
              ? `Based on ${totals.driveCount} drive${
                  totals.driveCount === 1 ? "" : "s"
                } -- segment runs, Go To trips, live races and solo runs combined. `
              : "No recorded drives yet. "}
            Top speed also counts plain driving with the app open.
          </Text>
        </>
      ) : (
        <Text style={styles.empty}>
          Nothing yet -- drive with the app open and your top speed starts building on its own, or race a track for
          the full set of stats.
        </Text>
      )}
    </ScrollView>
  );
}

function WorldStats() {
  const { user, units } = useUser();
  const [metric, setMetric] = useState<GlobalStatsMetric>("topSpeed");
  // The time boards: which shape, and the distance last looked at.
  const [timeShape, setTimeShape] = useState<SoloShape>("sprint");
  const [timeKey, setTimeKey] = useState<RaceDistanceKey>("quarter");
  const timeBoard = parseTimeMetric(metric);
  const [data, setData] = useState<GlobalStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (m: GlobalStatsMetric, isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.getGlobalStats(m, user?.deviceId);
        setData(res);
      } catch (e: any) {
        setError(e.message || "Couldn't reach the backend.");
      } finally {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [user?.deviceId]
  );

  useEffect(() => {
    load(metric, false);
  }, [metric, load]);

  const valueText = (e: GlobalStatsEntry) => {
    if (metric === "topSpeed") return `${displaySpeedKmh(e.topSpeedKmh, units)} ${speedUnit(units)}`;
    if (metric === "avgSpeed") return `${displaySpeedKmh(e.avgSpeedKmh, units)} ${speedUnit(units)}`;
    if (metric === "wins") return `${e.raceWins} of ${e.raceCount}`;
    if (timeBoard) {
      const ms = bestTimeMs(e, timeBoard.shape, timeBoard.key);
      return ms != null ? formatDuration(ms) : "--";
    }
    return formatDistanceShort(e.distanceM, units);
  };

  const meInList = !!data?.leaderboard.some((e) => e.isMe);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.metricRow}>
        {METRICS.map((m) => {
          const active = m.key === metric;
          return (
            <Pressable
              key={m.key}
              style={[styles.metricButton, active && styles.metricButtonActive]}
              onPress={() => setMetric(m.key)}
            >
              <Text style={[styles.metricText, active && styles.metricTextActive]} numberOfLines={1}>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {/* Fastest times: straight runs or loops, at any distance. */}
      <View style={[styles.metricRow, { alignItems: "center" }]}>
        <Text style={styles.timesLabel}>TIMES</Text>
        <ShapeSwitch
          shape={timeShape}
          onChange={(sh) => {
            setTimeShape(sh);
            setMetric(timeMetric(sh, timeBoard?.key ?? timeKey));
          }}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.distanceScroll}
        contentContainerStyle={styles.distanceScrollContent}
      >
        {RACE_DISTANCES.map((d) => {
          const active = !!timeBoard && timeBoard.key === d.key && timeBoard.shape === timeShape;
          return (
            <Pressable
              key={d.key}
              style={[styles.distanceChip, active && styles.metricButtonActive]}
              onPress={() => {
                setTimeKey(d.key);
                setMetric(timeMetric(timeShape, d.key));
              }}
            >
              <Text style={[styles.metricText, active && styles.metricTextActive]}>{d.short}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(metric, true)} tintColor={colors.cyan} />
        }
      >
        {loading ? (
          <ActivityIndicator color={colors.cyan} style={{ marginTop: 40 }} />
        ) : error ? (
          <Pressable onPress={() => load(metric, false)}>
            <Text style={styles.error}>{error}</Text>
            <Text style={styles.retry}>TAP TO RETRY</Text>
          </Pressable>
        ) : !data || data.leaderboard.length === 0 ? (
          <Text style={styles.empty}>No racers ranked here yet -- be the first.</Text>
        ) : (
          <>
            {data.leaderboard.map((e) => (
              <RankRow key={`${e.rank}-${e.displayName}`} entry={e} value={valueText(e)} />
            ))}
            <Text style={styles.footnote}>
              {data.totalRacers} racer{data.totalRacers === 1 ? "" : "s"} ranked worldwide
              {timeBoard
                ? ` -- each racer's fastest solo ${timeBoard.shape === "loop" ? "loop" : "run"} at ${
                    RACE_DISTANCES.find((d) => d.key === timeBoard.key)?.label ?? "this distance"
                  }`
                : metric === "wins"
                ? " -- head-to-head races won, out of races finished"
                : data.minDistanceM > 0
                ? ` -- average speed counts racers with at least ${formatDistanceShort(data.minDistanceM, units)} driven`
                : ""}
              . Pull down to refresh.
            </Text>
          </>
        )}
      </ScrollView>

      {/* Your own standing, always visible -- matters most when you're
          outside the top list and wouldn't otherwise see yourself. */}
      {!loading && !error && data && (
        <View style={styles.meBar}>
          {data.me ? (
            meInList ? (
              <Text style={styles.meBarText}>
                You're <Text style={styles.meBarRank}>#{data.me.rank}</Text> of {data.totalRacers} -- {valueText(data.me)}
              </Text>
            ) : (
              <RankRow entry={data.me} value={valueText(data.me)} />
            )
          ) : (
            <Text style={styles.meBarText}>
              {metric === "avgSpeed"
                ? `Drive at least ${formatDistanceShort(data.minDistanceM, units)} to get ranked here.`
                : "Record a drive to get ranked."}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function RankRow({ entry, value }: { entry: GlobalStatsEntry; value: string }) {
  const medal = entry.rank === 1 ? colors.gold : entry.rank <= 3 ? colors.cyan : colors.textSecondary;
  return (
    <View style={[styles.row, entry.isMe && styles.rowMe]}>
      <Text style={[styles.rank, { color: medal }]}>#{entry.rank}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>
          {entry.displayName}
          {entry.isMe ? "  (you)" : ""}
        </Text>
        <Text style={styles.drives}>
          {entry.driveCount} drive{entry.driveCount === 1 ? "" : "s"}
        </Text>
      </View>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 40 },
  tabRow: { flexDirection: "row", gap: 10, paddingHorizontal: 20, paddingTop: 16 },
  tabButton: { flex: 1, ...panelStyle, paddingVertical: 12, alignItems: "center" },
  tabButtonActive: { borderColor: colors.cyan, backgroundColor: colors.cyanDim },
  tabButtonText: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 13, letterSpacing: 1.5 },
  tabButtonTextActive: { color: colors.cyan },
  metricRow: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: 10 },
  timesLabel: { color: colors.textMuted, fontFamily: fonts.heading, fontSize: 11, letterSpacing: 1.5, marginRight: 4 },
  shapeSwitch: { flexDirection: "row", gap: 6, marginTop: 8 },
  shapeOption: {
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  shapeOptionActive: { borderColor: colors.gold, backgroundColor: "rgba(255, 207, 61, 0.12)" },
  shapeText: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  shapeTextActive: { color: colors.gold },
  distanceScroll: { flexGrow: 0, marginTop: 8 },
  distanceScrollContent: { paddingHorizontal: 20, gap: 8 },
  distanceChip: {
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 16,
    paddingVertical: 7,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  bestRow: { flexDirection: "row", justifyContent: "space-between", alignSelf: "stretch", marginTop: 10 },
  bestLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "700", letterSpacing: 1 },
  bestTime: { color: colors.gold, fontFamily: fonts.display, fontSize: 18 },
  bestNone: { color: colors.textMuted, fontSize: 16 },
  metricButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 16,
    paddingVertical: 7,
    alignItems: "center",
  },
  metricButtonActive: { borderColor: colors.racePrimary, backgroundColor: colors.racePrimaryDim },
  metricText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  metricTextActive: { color: colors.textPrimary },
  error: { color: colors.danger, textAlign: "center", marginTop: 40, paddingHorizontal: 20 },
  retry: { color: colors.textPrimary, textAlign: "center", marginTop: 8, fontSize: 12, fontWeight: "800" },
  empty: { color: colors.textSecondary, textAlign: "center", marginTop: 40, paddingHorizontal: 20, fontSize: 14 },
  tile: {
    ...panelStyle,
    padding: 20,
    alignItems: "center",
    marginBottom: 14,
  },
  tileLabel: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5 },
  tileValue: { color: colors.cyan, fontFamily: fonts.display, fontSize: 44, lineHeight: 52, marginTop: 6 },
  tileUnit: { color: colors.textSecondary, fontSize: 12, letterSpacing: 1, marginTop: 2 },
  footnote: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 12 },
  row: {
    ...panelStyle,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    gap: 12,
  },
  rowMe: { borderColor: colors.racePrimary, backgroundColor: colors.racePrimaryDim },
  rank: { fontFamily: fonts.display, fontSize: 18, minWidth: 44 },
  name: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  drives: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  value: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 14 },
  meBar: {
    borderTopWidth: 1,
    borderTopColor: colors.panelBorder,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 24,
  },
  meBarText: { color: colors.textSecondary, fontSize: 13, textAlign: "center", paddingVertical: 6 },
  meBarRank: { color: colors.racePrimary, fontWeight: "800" },
});
