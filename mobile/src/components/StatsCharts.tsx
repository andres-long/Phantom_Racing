import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, LayoutChangeEvent } from "react-native";
import Svg, { Line, Path, Circle } from "react-native-svg";
import { colors, fonts } from "../theme";

// Chart colours for the Stats dashboard. Checked for the dark panel surface
// (lightness band, chroma, colour-blind separation, contrast) -- the theme's
// own neon cyan/orange are too bright for chart marks, so the marks use these
// slightly deeper versions, and all text stays in the normal text colours.
export const SERIES_A = "#1ba3ae";
export const SERIES_B = "#d9502a";
const NEUTRAL = "#526279";
const GRID = "rgba(125, 147, 171, 0.18)";

export type ChartPoint = { label: string; value: number; display: string };

function niceStep(raw: number) {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// Up to three gridlines with round numbers, starting at zero.
function ticks(max: number) {
  const step = niceStep(max / 3);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(v);
  return { top, values: out };
}

function tickText(v: number) {
  return v >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v * 10) / 10}`;
}

const AXIS_W = 34;
const LABEL_H = 18;

function useWidth() {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  return { width, onLayout };
}

// The value you tapped (or the latest one), shown above the plot.
function Readout({ point, unit }: { point: ChartPoint | undefined; unit?: string }) {
  return (
    <View style={styles.readout}>
      <Text style={styles.readoutValue}>{point ? point.display : "--"}</Text>
      {unit ? <Text style={styles.readoutUnit}>{unit}</Text> : null}
      <Text style={styles.readoutLabel}>{point ? point.label : ""}</Text>
    </View>
  );
}

function GridLines({ width, height, tickValues, top }: { width: number; height: number; tickValues: number[]; top: number }) {
  return (
    <>
      {tickValues.map((v) => {
        const y = height - (v / top) * height;
        return <Line key={v} x1={AXIS_W} x2={width} y1={y} y2={y} stroke={GRID} strokeWidth={1} />;
      })}
    </>
  );
}

function AxisLabels({ height, tickValues, top }: { height: number; tickValues: number[]; top: number }) {
  return (
    <>
      {tickValues.map((v) => (
        <Text key={v} style={[styles.axisText, { top: height - (v / top) * height - 7 }]}>
          {tickText(v)}
        </Text>
      ))}
    </>
  );
}

// One series of bars (e.g. distance per week). Tap a bar for its value.
export function BarChart({ data, height = 140, unit }: { data: ChartPoint[]; height?: number; unit?: string }) {
  const { width, onLayout } = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const selected = sel ?? data.length - 1;
  const max = Math.max(0, ...data.map((d) => d.value));
  const { top, values } = ticks(max || 1);
  const plotW = Math.max(0, width - AXIS_W);
  const slot = data.length > 0 ? plotW / data.length : 0;
  const barW = Math.max(4, Math.min(28, slot - 6));
  const r = Math.min(4, barW / 2);

  return (
    <View>
      <Readout point={data[selected]} unit={unit} />
      <View onLayout={onLayout} style={{ height: height + LABEL_H }}>
        {width > 0 && (
          <>
            <Svg width={width} height={height}>
              <GridLines width={width} height={height} tickValues={values} top={top} />
              {data.map((d, i) => {
                const h = top > 0 ? (d.value / top) * height : 0;
                if (h <= 0) return null;
                const x = AXIS_W + i * slot + (slot - barW) / 2;
                const y = height - h;
                const rr = Math.min(r, h);
                // Rounded at the data end only; square on the baseline.
                const path = `M${x},${height} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + barW - rr},${y} Q${
                  x + barW
                },${y} ${x + barW},${y + rr} L${x + barW},${height} Z`;
                return (
                  <Path key={i} d={path} fill={SERIES_A} opacity={i === selected ? 1 : 0.55} />
                );
              })}
            </Svg>
            <AxisLabels height={height} tickValues={values} top={top} />
            {/* Tap targets: the whole column, not just the bar. */}
            <View style={[styles.hitRow, { left: AXIS_W, height: height + LABEL_H }]}>
              {data.map((d, i) => (
                <Pressable key={i} style={styles.hit} onPress={() => setSel(i)}>
                  <View style={{ flex: 1 }} />
                  <Text style={[styles.xLabel, i === selected && styles.xLabelActive]} numberOfLines={1}>
                    {d.label.split(" ").pop()}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

// One series as a line (e.g. top speed on each drive). Tap near a point.
export function LineChart({ data, height = 140, unit }: { data: ChartPoint[]; height?: number; unit?: string }) {
  const { width, onLayout } = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const selected = sel ?? data.length - 1;
  const max = Math.max(0, ...data.map((d) => d.value));
  const { top, values } = ticks(max || 1);
  const pad = 8;
  const plotW = Math.max(0, width - AXIS_W - pad * 2);
  const xAt = (i: number) => AXIS_W + pad + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
  const yAt = (v: number) => height - (v / top) * height;
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(d.value).toFixed(1)}`).join(" ");
  const sp = data[selected];

  return (
    <View>
      <Readout point={sp} unit={unit} />
      <View onLayout={onLayout} style={{ height: height + LABEL_H }}>
        {width > 0 && (
          <>
            <Svg width={width} height={height + 2}>
              <GridLines width={width} height={height} tickValues={values} top={top} />
              {sp && (
                <Line x1={xAt(selected)} x2={xAt(selected)} y1={0} y2={height} stroke={GRID} strokeWidth={1} />
              )}
              <Path d={path} stroke={SERIES_A} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
              {sp && (
                <Circle cx={xAt(selected)} cy={yAt(sp.value)} r={5} fill={SERIES_A} stroke={colors.bgElevated} strokeWidth={2} />
              )}
            </Svg>
            <AxisLabels height={height} tickValues={values} top={top} />
            <View style={[styles.hitRow, { left: AXIS_W, height: height + LABEL_H }]}>
              {data.map((d, i) => (
                <Pressable key={i} style={styles.hit} onPress={() => setSel(i)} />
              ))}
            </View>
            <View pointerEvents="none" style={[styles.lineLabels, { top: height + 2, left: AXIS_W }]}>
              <Text style={styles.xLabel}>{data[0]?.label ?? ""}</Text>
              <Text style={styles.xLabel}>{data.length > 1 ? data[data.length - 1].label : ""}</Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

// Won / lost / no result, as one split bar with its key underneath.
export function RecordBar({ won, lost, other }: { won: number; lost: number; other: number }) {
  const total = won + lost + other;
  const parts = [
    { key: "won", n: won, color: SERIES_A, label: "WON" },
    { key: "lost", n: lost, color: SERIES_B, label: "LOST" },
    { key: "other", n: other, color: NEUTRAL, label: "NO RESULT" },
  ].filter((p) => p.n > 0);
  return (
    <View>
      <View style={styles.recordBar}>
        {parts.map((p) => (
          <View key={p.key} style={{ flex: p.n, backgroundColor: p.color, borderRadius: 4 }} />
        ))}
        {total === 0 && <View style={{ flex: 1, backgroundColor: GRID, borderRadius: 4 }} />}
      </View>
      <View style={styles.legend}>
        {parts.map((p) => (
          <View key={p.key} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: p.color }]} />
            <Text style={styles.legendText}>
              {p.label} <Text style={styles.legendValue}>{p.n}</Text>
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function EmptyChart({ text }: { text: string }) {
  return (
    <View style={styles.emptyChart}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { flexDirection: "row", alignItems: "baseline", gap: 6, marginBottom: 8 },
  readoutValue: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 18 },
  readoutUnit: { color: colors.textSecondary, fontSize: 11, letterSpacing: 1 },
  readoutLabel: { color: colors.textMuted, fontSize: 11, marginLeft: "auto" },
  axisText: { position: "absolute", left: 0, width: AXIS_W - 6, textAlign: "right", color: colors.textMuted, fontSize: 9 },
  hitRow: { position: "absolute", top: 0, right: 0, flexDirection: "row" },
  hit: { flex: 1, alignItems: "center" },
  xLabel: { color: colors.textMuted, fontSize: 9, height: LABEL_H, paddingTop: 4 },
  xLabelActive: { color: colors.textPrimary, fontWeight: "700" },
  lineLabels: { position: "absolute", right: 0, flexDirection: "row", justifyContent: "space-between" },
  recordBar: { flexDirection: "row", gap: 2, height: 14 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  legendValue: { color: colors.textPrimary },
  emptyChart: { height: 80, alignItems: "center", justifyContent: "center" },
  emptyText: { color: colors.textMuted, fontSize: 12, textAlign: "center" },
});
