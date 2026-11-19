import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import NeonButton from "../components/NeonButton";
import { BarChart, LineChart, RecordBar, EmptyChart, ChartPoint } from "../components/StatsCharts";
import { carLabel, hpLabel } from "../utils/car";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

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

// One recorded drive of any kind, for the charts.
type Drive = { at: number; distanceM: number; durationMs: number; maxSpeedKmh: number };

const WEEKS_SHOWN = 8;
const DRIVES_SHOWN = 20;

function startOfWeek(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

function shortDate(ms: number) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// The Stats dashboard: big numbers up top, then how much you've driven week
// by week, your top speed drive by drive, your race record and your best
// solo times. Everything you've driven counts -- segment runs, Go To trips,
// live races and solo runs; top speed also counts plain driving with the
// app open. Average speed is distance-weighted (total distance / total
// time), so lots of short slow drives don't outweigh a few long fast ones.
function MyStats() {
  const { user, units } = useUser();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [raceOther, setRaceOther] = useState(0);
  const [solo, setSolo] = useState<SoloStatsResponse | null>(null);
  const [bestShape, setBestShape] = useState<SoloShape>("sprint");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (!user) return;
      if (isRefresh) setRefreshing(true);
      try {
        setError(null);
        // Races and the passive top speed fall back rather than failing
        // the whole screen: an older backend simply doesn't have those routes.
        const [runs, trips, races, top] = await Promise.all([
          api.getUserRuns(user.deviceId),
          api.getUserTrips(user.deviceId),
          api.getUserRaces(user.deviceId).catch(() => []),
          api.getTopSpeed(user.deviceId).catch(() => ({ topSpeedKmh: 0, topSpeedAt: null })),
        ]);
        const soloStats = await api.getUserSolo(user.deviceId).catch(() => null);
        setSolo(soloStats);
        const soloRuns = soloStats?.runs ?? [];

        const all: Drive[] = [...runs, ...trips, ...races, ...soloRuns].map((r) => ({
          at: new Date(r.recordedAt).getTime() || 0,
          distanceM: r.distanceM || 0,
          durationMs: r.durationMs || 0,
          maxSpeedKmh: r.maxSpeedKmh || 0,
        }));
        all.sort((a, b) => a.at - b.at);
        setDrives(all);

        let distanceM = 0;
        let durationMs = 0;
        let topSpeedKmh = 0;
        for (const d of all) {
          distanceM += d.distanceM;
          durationMs += d.durationMs;
          if (d.maxSpeedKmh > topSpeedKmh) topSpeedKmh = d.maxSpeedKmh;
        }
        // Your fastest ever, including while you weren't recording anything
        // -- knownTopSpeedKmh() covers a best set in this session that
        // hasn't been sent to the server yet.
        topSpeedKmh = Math.max(topSpeedKmh, top.topSpeedKmh, knownTopSpeedKmh());

        setRaceOther(races.filter((r) => r.won == null).length);
        setTotals({
          topSpeedKmh,
          distanceM,
          avgSpeedKmh: durationMs > 0 ? distanceM / 1000 / (durationMs / 3_600_000) : 0,
          driveCount: all.length,
          raceCount: races.length,
          raceWins: races.filter((r) => r.won === true).length,
        });
      } catch (e: any) {
        setError(e.message || "Couldn't reach the backend.");
      } finally {
        setLoading(false);
        if (isRefresh) setRefreshing(false);
      }
    },
    [user]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const formatDistance = (m: number) => formatDistanceShort(m, units);
  const distUnit = units === "imperial" ? "mi" : "km";
  const toDistUnit = (m: number) => (units === "imperial" ? m / 1609.344 : m / 1000);

  // Distance per week, the last 8 weeks (empty weeks included, so gaps show).
  const weekly: ChartPoint[] = useMemo(() => {
    const thisWeek = startOfWeek(Date.now());
    const weekMs = 7 * 24 * 3600 * 1000;
    const out: ChartPoint[] = [];
    for (let w = WEEKS_SHOWN - 1; w >= 0; w--) {
      // Step by dates, not fixed ms, so daylight-saving weeks line up.
      const start = startOfWeek(thisWeek - w * weekMs + 12 * 3600 * 1000);
      const end = startOfWeek(start + weekMs + 12 * 3600 * 1000);
      const m = drives.filter((d) => d.at >= start && d.at < end).reduce((s, d) => s + d.distanceM, 0);
      const v = toDistUnit(m);
      out.push({
        label: `Week of ${shortDate(start)}`,
        value: v,
        display: v >= 100 ? `${Math.round(v)}` : v.toFixed(1),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drives, units]);

  // Top speed on each of your last 20 drives.
  const speeds: ChartPoint[] = useMemo(
    () =>
      drives
        .filter((d) => d.maxSpeedKmh > 0)
        .slice(-DRIVES_SHOWN)
        .map((d) => ({
          label: shortDate(d.at),
          value: displaySpeedKmh(d.maxSpeedKmh, units),
          display: `${displaySpeedKmh(d.maxSpeedKmh, units)}`,
        })),
    [drives, units]
  );

  const anyWeekly = weekly.some((p) => p.value > 0);
  const bests = bestShape === "loop" ? solo?.loopBests : solo?.bests;
  const bestCount = RACE_DISTANCES.filter((d) => bests?.[d.key as RaceDistanceKey]).length;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.cyan} />}
    >
      {loading ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 40 }} />
      ) : error ? (
        <Pressable onPress={() => load(false)}>
          <Text style={styles.error}>{error}</Text>
          <Text style={styles.retry}>TAP TO RETRY</Text>
        </Pressable>
      ) : totals && (totals.driveCount > 0 || totals.topSpeedKmh > 0) ? (
        <>
          {/* Headline numbers. */}
          <View style={styles.heroTile}>
            <Text style={styles.tileLabel}>TOP SPEED</Text>
            <View style={styles.heroValueRow}>
              <Text style={styles.heroValue}>{displaySpeedKmh(totals.topSpeedKmh, units)}</Text>
              <Text style={styles.heroUnit}>{speedUnit(units)}</Text>
            </View>
            {user?.car ? <Text style={styles.heroCar}>{carLabel(user.car)}</Text> : null}
          </View>
          <View style={styles.tileGrid}>
            <StatTile
              label="DISTANCE"
              value={formatDistance(totals.distanceM).split(" ")[0]}
              unit={formatDistance(totals.distanceM).split(" ")[1]}
            />
            <StatTile label="AVG SPEED" value={`${displaySpeedKmh(totals.avgSpeedKmh, units)}`} unit={speedUnit(units)} />
            <StatTile label="DRIVES" value={`${totals.driveCount}`} unit="recorded" />
            <StatTile
              label="RACES WON"
              value={`${totals.raceWins}`}
              unit={totals.raceCount > 0 ? `of ${totals.raceCount}` : "no races yet"}
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>DISTANCE PER WEEK</Text>
            <Text style={styles.cardSub}>Last {WEEKS_SHOWN} weeks -- tap a bar</Text>
            {anyWeekly ? (
              <BarChart data={weekly} unit={distUnit} />
            ) : (
              <EmptyChart text="No drives in the last 8 weeks." />
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>TOP SPEED PER DRIVE</Text>
            <Text style={styles.cardSub}>
              Your last {Math.min(DRIVES_SHOWN, speeds.length) || DRIVES_SHOWN} drives -- tap the line
            </Text>
            {speeds.length >= 2 ? (
              <LineChart data={speeds} unit={speedUnit(units)} />
            ) : (
              <EmptyChart text="Record a couple of drives to see your speed over time." />
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>RACE RECORD</Text>
            {totals.raceCount > 0 ? (
              <>
                <Text style={styles.cardSub}>
                  {Math.round((totals.raceWins / totals.raceCount) * 100)}% win rate over {totals.raceCount} race
                  {totals.raceCount === 1 ? "" : "s"}
                </Text>
                <RecordBar
                  won={totals.raceWins}
                  lost={totals.raceCount - totals.raceWins - raceOther}
                  other={raceOther}
                />
              </>
            ) : (
              <EmptyChart text="Challenge a racer on the map to start your record." />
            )}
          </View>

          {/* Personal bests from solo runs -- straight runs and loops apart. */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>BEST SOLO TIMES</Text>
                <Text style={styles.cardSub}>
                  {bestCount} of {RACE_DISTANCES.length} distances set
                </Text>
              </View>
              <ShapeSwitch shape={bestShape} onChange={setBestShape} />
            </View>
            <View style={styles.bestGrid}>
              {RACE_DISTANCES.map((d) => {
                const best = bests?.[d.key as RaceDistanceKey] ?? null;
                return (
                  <View key={d.key} style={[styles.bestCell, best && styles.bestCellSet]}>
                    <Text style={styles.bestLabel}>{d.short}</Text>
                    <Text style={best ? styles.bestTime : styles.bestNone}>
                      {best ? formatDuration(best.durationMs) : "--"}
                    </Text>
                    {best ? (
                      <Text style={styles.bestSpeed}>
                        {displaySpeedKmh(best.avgSpeedKmh, units)} {speedUnit(units)} avg
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>

          <NeonButton
            label="SHARE MY STATS"
            variant="outline"
            onPress={() =>
              navigation.navigate("ShareDrive", {
                title: `${user?.displayName ?? ""}`.toUpperCase(),
                titleIsName: true,
                subtitle: "LIFETIME",
                stats: [
                  { label: "Top speed", value: `${displaySpeedKmh(totals.topSpeedKmh, units)} ${speedUnit(units)}` },
                  { label: "Distance driven", value: formatDistance(totals.distanceM) },
                  { label: "Avg speed", value: `${displaySpeedKmh(totals.avgSpeedKmh, units)} ${speedUnit(units)}` },
                  totals.raceCount > 0
                    ? { label: "Races won", value: `${totals.raceWins} of ${totals.raceCount}` }
                    : { label: "Drives", value: `${totals.driveCount}` },
                ],
              })
            }
          />
          <Text style={styles.footnote}>
            Segment runs, Go To trips, live races and solo runs combined. Top speed also counts plain driving with the
            app open. Pull down to refresh.
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

function StatTile({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={styles.smallTile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.smallValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.tileUnit}>{unit}</Text>
    </View>
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
            <Podium entries={data.leaderboard.slice(0, 3)} valueText={valueText} />
            {data.leaderboard.slice(3).map((e) => (
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

const PODIUM_COLORS = [colors.gold, "#c9d6e3", "#d98a4a"];
const PODIUM_HEIGHTS = [86, 62, 46];

// The top three, on a podium: 2nd, 1st, 3rd.
function Podium({ entries, valueText }: { entries: GlobalStatsEntry[]; valueText: (e: GlobalStatsEntry) => string }) {
  if (entries.length === 0) return null;
  const order = [entries[1], entries[0], entries[2]];
  return (
    <View style={styles.podium}>
      {order.map((e, i) => {
        if (!e) return <View key={`empty-${i}`} style={styles.podiumCol} />;
        const place = e.rank - 1;
        const color = PODIUM_COLORS[Math.min(2, Math.max(0, place))];
        const height = PODIUM_HEIGHTS[Math.min(2, Math.max(0, place))];
        return (
          <View key={`${e.rank}-${e.displayName}`} style={styles.podiumCol}>
            <Text style={[styles.podiumName, e.isMe && { color: colors.racePrimary }]} numberOfLines={1}>
              {e.displayName}
              {e.isMe ? " (you)" : ""}
            </Text>
            <Text style={styles.podiumValue} numberOfLines={1} adjustsFontSizeToFit>
              {valueText(e)}
            </Text>
            <Text style={styles.podiumHp} numberOfLines={1}>
              {e.car ? hpLabel(e.car) : " "}
            </Text>
            <View style={[styles.podiumBlock, { height, borderColor: color }]}>
              <Text style={[styles.podiumRank, { color }]}>{e.rank}</Text>
            </View>
          </View>
        );
      })}
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
        <Text style={styles.drives} numberOfLines={1}>
          {entry.driveCount} drive{entry.driveCount === 1 ? "" : "s"}
          {entry.car ? `  ·  ${carLabel(entry.car)}` : ""}
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
  shapeSwitch: { flexDirection: "row", gap: 6 },
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
  bestLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  bestTime: { color: colors.gold, fontFamily: fonts.display, fontSize: 16, marginTop: 4 },
  bestNone: { color: colors.textMuted, fontSize: 16, marginTop: 4 },
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
  heroTile: { ...panelStyle, padding: 20, alignItems: "center", marginBottom: 10, borderColor: colors.panelBorderStrong },
  heroValueRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 4 },
  heroValue: { color: colors.cyan, fontFamily: fonts.display, fontSize: 64, lineHeight: 74 },
  heroUnit: { color: colors.textSecondary, fontSize: 14, letterSpacing: 1 },
  heroCar: { color: colors.textSecondary, fontSize: 12, marginTop: 4, letterSpacing: 0.5 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 14 },
  smallTile: { ...panelStyle, flexBasis: "47%", flexGrow: 1, paddingVertical: 14, paddingHorizontal: 12, alignItems: "center" },
  smallValue: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 28, lineHeight: 34, marginTop: 6 },
  card: { ...panelStyle, padding: 16, marginBottom: 14 },
  cardHeaderRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  cardTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5 },
  cardSub: { color: colors.textMuted, fontSize: 11, marginTop: 3, marginBottom: 12 },
  bestGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bestCell: {
    flexBasis: "30%",
    flexGrow: 1,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 4,
    paddingVertical: 10,
    alignItems: "center",
  },
  bestCellSet: { borderColor: "rgba(255, 207, 61, 0.45)", backgroundColor: "rgba(255, 207, 61, 0.06)" },
  bestSpeed: { color: colors.textMuted, fontSize: 9, marginTop: 2 },
  podium: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginBottom: 16, marginTop: 4 },
  podiumCol: { flex: 1, alignItems: "center" },
  podiumName: { color: colors.textPrimary, fontSize: 13, fontWeight: "800", maxWidth: "100%" },
  podiumValue: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 13, marginTop: 2 },
  podiumHp: { color: colors.textMuted, fontSize: 10, marginTop: 2, marginBottom: 6 },
  podiumBlock: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderBottomWidth: 0,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    backgroundColor: colors.panel,
    alignItems: "center",
    paddingTop: 8,
  },
  podiumRank: { fontFamily: fonts.display, fontSize: 26 },
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
