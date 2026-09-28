import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Image, Alert, ActivityIndicator, useWindowDimensions } from "react-native";
import MapView, { Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Polyline as SvgPolyline, Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { toLocalXY, resamplePolyline } from "../utils/geo";
import { colors, fonts } from "../theme";
import { tronMapStyle } from "../mapStyle";
import NeonButton from "../components/NeonButton";
import { shareSupport, canShareImage, pickPhoto, shareViewAsImage } from "../shareNative";

type Props = NativeStackScreenProps<RootStackParamList, "ShareDrive">;

// What's behind the stats: your own photo (Strava-style overlay), the map
// with the route on it, a plain branded card, or nothing at all (a
// transparent sticker to drop onto a story).
type Backdrop = "photo" | "map" | "card" | "clear";

const BACKDROPS: { key: Backdrop; label: string }[] = [
  { key: "photo", label: "PHOTO" },
  { key: "map", label: "MAP" },
  { key: "card", label: "CARD" },
  { key: "clear", label: "CLEAR" },
];

// Saved at story size (9:16).
const OUT_W = 1080;
const OUT_H = 1920;
const TEXT_SHADOW = { textShadowColor: "rgba(0,0,0,0.75)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 };

// Share a drive -- a track run, a solo run, a race, a Go To trip, or your
// lifetime stats -- as a story-sized image: the numbers stacked over a
// photo like Strava's overlay, over the map with the route drawn on it, on
// a branded card, or as a transparent sticker.
export default function ShareDriveScreen({ route, navigation }: Props) {
  const { title, subtitle, stats, segmentId, raceId } = route.params;
  const { user } = useUser();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  const [backdrop, setBackdrop] = useState<Backdrop>(route.params.route?.length || segmentId || raceId ? "map" : "card");
  const [path, setPath] = useState<LatLng[] | null>(route.params.route && route.params.route.length >= 2 ? route.params.route : null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [mapShot, setMapShot] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<LatLng | null>(null);
  const [sharing, setSharing] = useState(false);
  // Everything but the card hidden, for a clean screenshot (older app builds).
  const [clean, setClean] = useState(false);

  const cardRef = useRef<View | null>(null);
  const mapRef = useRef<MapView | null>(null);

  // The card as big as fits above the controls, at 9:16.
  const cardW = Math.min(winW - 32, ((winH - insets.top - insets.bottom - 230) * 9) / 16);
  const cardH = (cardW * 16) / 9;
  const scale = cardW / 360;

  // The route, if it wasn't passed in: the track's line or the race course.
  useEffect(() => {
    if (path) return;
    let cancelled = false;
    (async () => {
      try {
        if (segmentId) {
          const seg = await api.getSegment(segmentId, user?.deviceId);
          if (!cancelled && seg.points.length >= 2) setPath(seg.points);
        } else if (raceId && user) {
          const r = await api.getRaceChallenge(raceId, user.deviceId);
          if (!cancelled && r.course && r.course.length >= 2) setPath(r.course);
        }
      } catch {
        // No line then -- the stats still share.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId, raceId]);

  // No route (lifetime stats): the map shows where you are.
  useEffect(() => {
    if (path || mapCenter) return;
    Location.getLastKnownPositionAsync({})
      .then((loc) => loc && setMapCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude }))
      .catch(() => {});
  }, [path, mapCenter]);

  // Keep the drawn line light: a few hundred points is plenty at this size.
  const drawPath = useMemo(() => (path && path.length > 300 ? resamplePolyline(path, 300) : path), [path]);

  // The route as an SVG line, fitted into a box, north up.
  const routeSvg = useMemo(() => {
    if (!drawPath || drawPath.length < 2) return null;
    const xy = toLocalXY(drawPath);
    const xs = xy.map((p) => p.x);
    const ys = xy.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const boxW = 220 * scale;
    const boxH = 150 * scale;
    const pad = 8 * scale;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const k = Math.min((boxW - 2 * pad) / spanX, (boxH - 2 * pad) / spanY);
    const offX = (boxW - spanX * k) / 2;
    const offY = (boxH - spanY * k) / 2;
    const pts = xy.map((p) => ({ x: offX + (p.x - minX) * k, y: boxH - (offY + (p.y - minY) * k) }));
    return { boxW, boxH, points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), start: pts[0], end: pts[pts.length - 1] };
  }, [drawPath, scale]);

  // Map backdrop: fit the route, then freeze it into a picture -- a live map
  // can't be captured into an image, a snapshot of it can.
  const onMapReady = () => {
    const fit = () => {
      if (!drawPath || drawPath.length < 2) return;
      // The route should sit in the lower half, under the numbers. Rather
      // than rely on edge padding (pixels on some Android versions, points
      // on others), fit to the route plus a margin box stretched upwards.
      const lats = drawPath.map((p) => p.lat);
      const lngs = drawPath.map((p) => p.lng);
      const n = Math.max(...lats);
      const sLat = Math.min(...lats);
      const e = Math.max(...lngs);
      const w = Math.min(...lngs);
      const latSpan = Math.max(n - sLat, 0.0008);
      const lngSpan = Math.max(e - w, 0.0008);
      const box = [
        { latitude: n + latSpan * 1.1, longitude: w - lngSpan * 0.12 },
        { latitude: sLat - latSpan * 0.25, longitude: e + lngSpan * 0.12 },
      ];
      mapRef.current?.fitToCoordinates(
        [...drawPath.map((p) => ({ latitude: p.lat, longitude: p.lng })), ...box],
        { edgePadding: { top: 0, right: 0, bottom: 0, left: 0 }, animated: false }
      );
    };
    fit();
    setTimeout(async () => {
      try {
        const uri = await mapRef.current?.takeSnapshot({ format: "png", result: "file" });
        if (uri) setMapShot(uri);
      } catch {
        // Keep the live map on screen; a screenshot still works.
      }
    }, 1500);
  };

  // A new route or center means a new snapshot.
  useEffect(() => {
    setMapShot(null);
  }, [drawPath, mapCenter]);

  const choosePhoto = async (fromCamera: boolean) => {
    if (!shareSupport.picker) {
      Alert.alert("Needs the app update", "Adding your own photo arrives with the next app update. The map, card and clear styles work now.");
      return;
    }
    try {
      const uri = await pickPhoto(fromCamera);
      if (uri) setPhotoUri(uri);
    } catch (e: any) {
      Alert.alert("Couldn't get the photo", e.message || "Try again.");
    }
  };

  const onShare = async () => {
    if (!canShareImage) {
      setClean(true);
      return;
    }
    if (backdrop === "photo" && !photoUri) {
      choosePhoto(false);
      return;
    }
    setSharing(true);
    try {
      await shareViewAsImage(cardRef, OUT_W, OUT_H);
    } catch (e: any) {
      Alert.alert("Couldn't share", e.message || "Try again.");
    } finally {
      setSharing(false);
    }
  };

  const onPhotoBackdrop = backdrop === "photo" || backdrop === "clear";

  // ---- the card itself -------------------------------------------------------
  const statBlock = (
    <View style={styles.statsStack}>
      {stats.slice(0, 4).map((s) => (
        <View key={s.label} style={{ alignItems: "center", marginTop: 10 * scale }}>
          <Text style={[styles.statLabel, TEXT_SHADOW, { fontSize: 10 * scale }]}>{s.label}</Text>
          <Text style={[styles.statValue, TEXT_SHADOW, { fontSize: 26 * scale }]} numberOfLines={1}>
            {s.value}
          </Text>
        </View>
      ))}
    </View>
  );

  const routeBlock = routeSvg && (
    <Svg width={routeSvg.boxW} height={routeSvg.boxH} style={{ marginTop: 16 * scale }}>
      <SvgPolyline
        points={routeSvg.points}
        fill="none"
        stroke={colors.racePrimary}
        strokeWidth={4 * scale}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={routeSvg.start.x} cy={routeSvg.start.y} r={4 * scale} fill="#ffffff" />
      <Circle cx={routeSvg.end.x} cy={routeSvg.end.y} r={4 * scale} fill={colors.gold} />
    </Svg>
  );

  const wordmark = (
    <Text style={[styles.wordmark, TEXT_SHADOW, { fontSize: 15 * scale, marginTop: 14 * scale }]}>PHANTOM RACING</Text>
  );

  const header = (
    <>
      <Text style={[styles.title, TEXT_SHADOW, { fontSize: 13 * scale }]} numberOfLines={2}>
        {title}
      </Text>
      {!!subtitle && (
        <Text style={[styles.subtitle, TEXT_SHADOW, { fontSize: 11 * scale }]} numberOfLines={1}>
          {subtitle}
        </Text>
      )}
    </>
  );

  const renderCard = () => (
    <View
      ref={cardRef}
      collapsable={false}
      style={[styles.card, { width: cardW, height: cardH }, backdrop === "clear" ? null : styles.cardSolid]}
    >
      {backdrop === "photo" &&
        (photoUri ? (
          <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Pressable style={styles.photoEmpty} onPress={() => choosePhoto(false)}>
            <Text style={styles.photoEmptyText}>TAP TO PICK A PHOTO</Text>
          </Pressable>
        ))}

      {backdrop === "card" && (
        <LinearGradient colors={["#0b1a2e", "#05070c", "#2a0d0a"]} style={StyleSheet.absoluteFill} />
      )}

      {backdrop === "map" &&
        (mapShot ? (
          <Image source={{ uri: mapShot }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <MapView
            key={`${drawPath?.length ?? 0}-${mapCenter ? "c" : "n"}`}
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            provider={PROVIDER_GOOGLE}
            customMapStyle={tronMapStyle}
            onMapReady={onMapReady}
            scrollEnabled={false}
            zoomEnabled={false}
            rotateEnabled={false}
            pitchEnabled={false}
            toolbarEnabled={false}
            initialRegion={
              drawPath
                ? { latitude: drawPath[0].lat, longitude: drawPath[0].lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }
                : mapCenter
                ? { latitude: mapCenter.lat, longitude: mapCenter.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 }
                : undefined
            }
          >
            {drawPath && (
              <Polyline
                coordinates={drawPath.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
                strokeColor={colors.racePrimary}
                strokeWidth={5}
              />
            )}
          </MapView>
        ))}

      {backdrop === "map" ? (
        <>
          {/* Numbers on a dark band across the top, the map below. */}
          <LinearGradient
            colors={["rgba(5,7,12,0.92)", "rgba(5,7,12,0.7)", "rgba(5,7,12,0)"]}
            style={[styles.mapBand, { height: cardH * 0.46 }]}
            pointerEvents="none"
          />
          <View style={[styles.mapTop, { paddingTop: 22 * scale }]} pointerEvents="none">
            {header}
            {statBlock}
          </View>
          <View style={[styles.mapBottom, { bottom: 14 * scale }]} pointerEvents="none">
            {wordmark}
          </View>
        </>
      ) : (
        <View
          style={[styles.centerStack, { paddingTop: (onPhotoBackdrop ? 70 : 90) * scale }]}
          pointerEvents="none"
        >
          {header}
          {statBlock}
          {routeBlock}
          {wordmark}
        </View>
      )}
    </View>
  );

  // Screenshot mode: just the card, centred. Tap anywhere to come back.
  if (clean) {
    return (
      <Pressable style={styles.cleanWrap} onPress={() => setClean(false)}>
        {backdrop === "clear" && <Checkerboard width={cardW} height={cardH} />}
        {renderCard()}
      </Pressable>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.topRow}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={styles.close}>
          <Text style={styles.closeText}>x</Text>
        </Pressable>
        <Text style={styles.screenTitle}>SHARE</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={[styles.cardWrap, { width: cardW, height: cardH }]}>
        {backdrop === "clear" && <Checkerboard width={cardW} height={cardH} />}
        {renderCard()}
      </View>

      <View style={styles.segment}>
        {BACKDROPS.map((b) => (
          <Pressable
            key={b.key}
            style={[styles.segmentOption, backdrop === b.key && styles.segmentOptionActive]}
            onPress={() => setBackdrop(b.key)}
          >
            <Text style={[styles.segmentText, backdrop === b.key && styles.segmentTextActive]}>{b.label}</Text>
          </Pressable>
        ))}
      </View>

      {backdrop === "photo" && (
        <View style={styles.photoRow}>
          <Pressable style={styles.photoButton} onPress={() => choosePhoto(false)}>
            <Text style={styles.photoButtonText}>GALLERY</Text>
          </Pressable>
          <Pressable style={styles.photoButton} onPress={() => choosePhoto(true)}>
            <Text style={styles.photoButtonText}>CAMERA</Text>
          </Pressable>
        </View>
      )}

      {sharing ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 14 }} />
      ) : (
        <NeonButton
          label={canShareImage ? "SHARE" : "SCREENSHOT VIEW"}
          onPress={onShare}
          style={styles.shareButton}
        />
      )}
      {!canShareImage && (
        <Text style={styles.hint}>
          Shows just the card -- take a screenshot and post it. One-tap sharing and your own photos arrive with the
          next app update.
        </Text>
      )}
    </View>
  );
}

// The see-through backdrop's preview only -- never part of the image.
function Checkerboard({ width, height }: { width: number; height: number }) {
  const size = 16;
  const cols = Math.ceil(width / size);
  const rows = Math.ceil(height / size);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 === 0) {
        cells.push(
          <View key={`${r}-${c}`} style={{ position: "absolute", left: c * size, top: r * size, width: size, height: size, backgroundColor: "#2a2f38" }} />
        );
      }
    }
  }
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: "#1a1e25", overflow: "hidden", width, height }]}>{cells}</View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: "center" },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", alignSelf: "stretch", paddingHorizontal: 16, marginBottom: 10 },
  close: {
    width: 36,
    height: 36,
    borderRadius: 4,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: colors.cyan, fontSize: 16, fontWeight: "800" },
  screenTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 15, letterSpacing: 2 },
  cardWrap: { borderRadius: 10, overflow: "hidden" },
  card: { overflow: "hidden" },
  cardSolid: { backgroundColor: colors.bg },
  photoEmpty: { ...StyleSheet.absoluteFill, backgroundColor: "#10151d", alignItems: "center", justifyContent: "flex-end", paddingBottom: 40 },
  photoEmptyText: { color: colors.textMuted, fontSize: 12, fontWeight: "800", letterSpacing: 1.5 },
  centerStack: { ...StyleSheet.absoluteFill, alignItems: "center" },
  mapBand: { position: "absolute", left: 0, right: 0, top: 0 },
  mapTop: { position: "absolute", left: 0, right: 0, top: 0, alignItems: "center" },
  mapBottom: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  statsStack: { alignItems: "center" },
  title: { color: "#ffffff", fontFamily: fonts.heading, letterSpacing: 1.5, textAlign: "center", paddingHorizontal: 20 },
  subtitle: { color: colors.gold, fontFamily: fonts.heading, letterSpacing: 1.5, marginTop: 4, textAlign: "center" },
  statLabel: { color: "rgba(255,255,255,0.85)", fontWeight: "700", letterSpacing: 1 },
  statValue: { color: "#ffffff", fontFamily: fonts.heading },
  wordmark: { color: "#ffffff", fontFamily: fonts.display, letterSpacing: 3 },
  segment: { flexDirection: "row", gap: 8, marginTop: 14 },
  segmentOption: { borderWidth: 1, borderColor: colors.panelBorder, borderRadius: 16, paddingVertical: 7, paddingHorizontal: 14 },
  segmentOptionActive: { borderColor: colors.racePrimary, backgroundColor: colors.racePrimaryDim },
  segmentText: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  segmentTextActive: { color: colors.textPrimary },
  photoRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  photoButton: { borderWidth: 1, borderColor: colors.cyan, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 18 },
  photoButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  shareButton: { marginTop: 12, width: "80%" },
  hint: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 8, paddingHorizontal: 30 },
  cleanWrap: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
});
