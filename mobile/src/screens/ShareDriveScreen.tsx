import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Image,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
  useWindowDimensions,
} from "react-native";
import MapView, { Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Polyline as SvgPolyline, Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng, SegmentSummary, RunHistoryEntry } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { toLocalXY, resamplePolyline, formatDuration } from "../utils/geo";
import { displaySpeedKmh, speedUnit, formatDistanceLong } from "../utils/units";
import { colors, fonts } from "../theme";
import { tronMapStyle } from "../mapStyle";
import NeonButton from "../components/NeonButton";
import { shareSupport, canShareImage, pickPhoto, shareViewAsImage } from "../shareNative";

type Props = NativeStackScreenProps<RootStackParamList, "ShareDrive">;

// What's behind the stats: your own photo (the Strava-style overlay -- the
// numbers, the route line and the wordmark floating straight on the
// picture), the map with the route on it, or a plain branded card.
type Backdrop = "photo" | "map" | "card";

const BACKDROPS: { key: Backdrop; label: string }[] = [
  { key: "photo", label: "PHOTO" },
  { key: "map", label: "MAP" },
  { key: "card", label: "CARD" },
];

// What the card shows: the drive you came from, or any track you pick.
type Content = {
  title: string;
  subtitle?: string;
  stats: { label: string; value: string }[];
  route: LatLng[] | null;
  segmentId?: string;
  raceId?: string;
};

// A track you can pick to share, with your own best on it (if any).
type TrackChoice = { segment: SegmentSummary; best: RunHistoryEntry | null };

// Saved at story size (9:16).
const OUT_W = 1080;
const OUT_H = 1920;
const TEXT_SHADOW = { textShadowColor: "rgba(0,0,0,0.55)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 };

// Share a drive -- a track run, a solo run, a race, a Go To trip, any track,
// or your lifetime stats -- as a story-sized image.
export default function ShareDriveScreen({ route, navigation }: Props) {
  const { user, units } = useUser();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  const fromDrive: Content = {
    title: route.params.title,
    subtitle: route.params.subtitle,
    stats: route.params.stats,
    route: route.params.route && route.params.route.length >= 2 ? route.params.route : null,
    segmentId: route.params.segmentId,
    raceId: route.params.raceId,
  };
  const [content, setContent] = useState<Content>(fromDrive);
  const [backdrop, setBackdrop] = useState<Backdrop>(
    fromDrive.route || fromDrive.segmentId || fromDrive.raceId ? "map" : "card"
  );
  const [path, setPath] = useState<LatLng[] | null>(fromDrive.route);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [mapShot, setMapShot] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<LatLng | null>(null);
  const [sharing, setSharing] = useState(false);
  // Everything but the card hidden, for a clean screenshot (older app builds).
  const [clean, setClean] = useState(false);
  // The "which track?" picker.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [choices, setChoices] = useState<TrackChoice[] | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [loadingTrack, setLoadingTrack] = useState(false);

  const cardRef = useRef<View | null>(null);
  const mapRef = useRef<MapView | null>(null);

  // The card as big as fits above the controls, at 9:16.
  const cardW = Math.min(winW - 32, ((winH - insets.top - insets.bottom - 270) * 9) / 16);
  const cardH = (cardW * 16) / 9;
  const scale = cardW / 360;

  // The route, if it wasn't passed in: the track's line or the race course.
  useEffect(() => {
    if (content.route) {
      setPath(content.route);
      return;
    }
    setPath(null);
    let cancelled = false;
    (async () => {
      try {
        if (content.segmentId) {
          const seg = await api.getSegment(content.segmentId, user?.deviceId);
          if (!cancelled && seg.points.length >= 2) setPath(seg.points);
        } else if (content.raceId && user) {
          const r = await api.getRaceChallenge(content.raceId, user.deviceId);
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
  }, [content]);

  // No route (lifetime stats): the map shows where you are.
  useEffect(() => {
    if (path || mapCenter) return;
    Location.getLastKnownPositionAsync({})
      .then((loc) => loc && setMapCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude }))
      .catch(() => {});
  }, [path, mapCenter]);

  // Opened on a track (All Tracks' SHARE): fill in your own best on it.
  useEffect(() => {
    if (route.params.trackId) chooseTrack(route.params.trackId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the drawn line light: a few hundred points is plenty at this size.
  const drawPath = useMemo(() => (path && path.length > 300 ? resamplePolyline(path, 300) : path), [path]);

  // The route as an SVG line fitted into a box, north up. On a photo it's
  // the thin Strava-style squiggle; on the card it's bigger, with start and
  // finish dots.
  const routeSvg = useMemo(() => {
    if (!drawPath || drawPath.length < 2) return null;
    const xy = toLocalXY(drawPath);
    const xs = xy.map((p) => p.x);
    const ys = xy.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const boxW = (backdrop === "photo" ? 150 : 220) * scale;
    const boxH = (backdrop === "photo" ? 120 : 150) * scale;
    const pad = 6 * scale;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const k = Math.min((boxW - 2 * pad) / spanX, (boxH - 2 * pad) / spanY);
    const offX = (boxW - spanX * k) / 2;
    const offY = (boxH - spanY * k) / 2;
    const pts = xy.map((p) => ({ x: offX + (p.x - minX) * k, y: boxH - (offY + (p.y - minY) * k) }));
    return {
      boxW,
      boxH,
      points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
      start: pts[0],
      end: pts[pts.length - 1],
    };
  }, [drawPath, scale, backdrop]);

  // Map backdrop: fit the route, then freeze it into a picture -- a live map
  // can't be captured into an image, a snapshot of it can.
  const onMapReady = () => {
    if (drawPath && drawPath.length >= 2) {
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
    }
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
      Alert.alert(
        "Needs the app update",
        "Putting your stats on your own photo arrives with the next app update. The map and card styles work now."
      );
      return;
    }
    try {
      const uri = await pickPhoto(fromCamera);
      if (uri) setPhotoUri(uri);
    } catch (e: any) {
      Alert.alert("Couldn't get the photo", e.message || "Try again.");
    }
  };

  // ---- picking a track -------------------------------------------------------

  // Your tracks: every one you've run (with your best) and every one you
  // made, most-run-by-you first; then the rest of the tracks near the top.
  const openPicker = async () => {
    setPickerOpen(true);
    if (choices || !user) return;
    setChoicesError(null);
    try {
      const [segments, runs] = await Promise.all([api.listSegments(user.deviceId), api.getUserRuns(user.deviceId)]);
      const bestBySeg = new Map<string, RunHistoryEntry>();
      const countBySeg = new Map<string, number>();
      for (const r of runs) {
        countBySeg.set(r.segmentId, (countBySeg.get(r.segmentId) ?? 0) + 1);
        const cur = bestBySeg.get(r.segmentId);
        if (!cur || r.durationMs < cur.durationMs) bestBySeg.set(r.segmentId, r);
      }
      const list = segments
        .filter((s) => s.points.length >= 2)
        .map((s) => ({ segment: s, best: bestBySeg.get(s.id) ?? null }))
        .sort((a, b) => {
          const mineA = a.best || a.segment.creatorId === user.id ? 1 : 0;
          const mineB = b.best || b.segment.creatorId === user.id ? 1 : 0;
          if (mineA !== mineB) return mineB - mineA;
          return (countBySeg.get(b.segment.id) ?? 0) - (countBySeg.get(a.segment.id) ?? 0);
        });
      setChoices(list);
    } catch (e: any) {
      setChoicesError(e.message || "Couldn't load your tracks.");
    }
  };

  // Put a track on the card: its line, and your best on it -- or, if you
  // haven't run it, its record.
  const chooseTrack = async (segmentId: string) => {
    setPickerOpen(false);
    setLoadingTrack(true);
    try {
      const seg = choices?.find((c) => c.segment.id === segmentId)?.segment ?? (await api.getSegment(segmentId, user?.deviceId));
      let best = choices?.find((c) => c.segment.id === segmentId)?.best ?? null;
      if (!choices && user) {
        const runs = await api.getUserRuns(user.deviceId).catch(() => [] as RunHistoryEntry[]);
        for (const r of runs) if (r.segmentId === segmentId && (!best || r.durationMs < best.durationMs)) best = r;
      }
      let subtitle: string | undefined;
      if (best && user) {
        try {
          // The board lists runs; rank by each racer's best (first) entry.
          const board = await api.getLeaderboard(segmentId, user.deviceId);
          const racers: string[] = [];
          for (const e of board.leaderboard) if (!racers.includes(e.userId)) racers.push(e.userId);
          const place = racers.indexOf(user.id) + 1;
          if (place > 0) subtitle = place === 1 ? "TRACK RECORD" : `#${place} OF ${racers.length}`;
        } catch {
          // Rank's a nicety.
        }
      }
      const length = { label: "Distance", value: formatDistanceLong(seg.lengthM, units, 2) };
      const stats = best
        ? [
            length,
            { label: "My best", value: formatDuration(best.durationMs) },
            { label: "Avg speed", value: `${displaySpeedKmh(best.avgSpeedKmh, units)} ${speedUnit(units)}` },
            { label: "Top speed", value: `${displaySpeedKmh(best.maxSpeedKmh, units)} ${speedUnit(units)}` },
          ]
        : [
            length,
            {
              label: "Record",
              value: seg.bestTimeMs != null ? formatDuration(seg.bestTimeMs) : "--",
            },
            { label: "Runs", value: `${seg.runCount}` },
          ];
      setContent({
        title: seg.name.toUpperCase(),
        subtitle: subtitle ?? (!best && seg.bestTimeUser ? `RECORD BY ${seg.bestTimeUser.toUpperCase()}` : undefined),
        stats,
        route: seg.points.length >= 2 ? seg.points : null,
        segmentId: seg.id,
      });
      if (backdrop === "card" && !photoUri) setBackdrop("map");
    } catch (e: any) {
      Alert.alert("Couldn't load that track", e.message || "Try again.");
    } finally {
      setLoadingTrack(false);
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

  // ---- the card itself -------------------------------------------------------
  const onPhoto = backdrop === "photo";

  const statBlock = (
    <View style={styles.statsStack}>
      {content.stats.slice(0, 4).map((s) => (
        <View key={s.label} style={{ alignItems: "center", marginTop: (onPhoto ? 8 : 10) * scale }}>
          <Text
            style={[
              onPhoto ? styles.photoLabel : styles.statLabel,
              TEXT_SHADOW,
              { fontSize: (onPhoto ? 11 : 10) * scale },
            ]}
          >
            {s.label}
          </Text>
          <Text
            style={[onPhoto ? styles.photoValue : styles.statValue, TEXT_SHADOW, { fontSize: (onPhoto ? 25 : 26) * scale }]}
            numberOfLines={1}
          >
            {s.value}
          </Text>
        </View>
      ))}
    </View>
  );

  const routeBlock = routeSvg && (
    <Svg width={routeSvg.boxW} height={routeSvg.boxH} style={{ marginTop: (onPhoto ? 12 : 16) * scale }}>
      <SvgPolyline
        points={routeSvg.points}
        fill="none"
        stroke={colors.racePrimary}
        strokeWidth={(onPhoto ? 3 : 4) * scale}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {!onPhoto && <Circle cx={routeSvg.start.x} cy={routeSvg.start.y} r={4 * scale} fill="#ffffff" />}
      {!onPhoto && <Circle cx={routeSvg.end.x} cy={routeSvg.end.y} r={4 * scale} fill={colors.gold} />}
    </Svg>
  );

  const wordmark = (
    <Text style={[styles.wordmark, TEXT_SHADOW, { fontSize: (onPhoto ? 14 : 15) * scale, marginTop: 12 * scale }]}>
      PHANTOM RACING
    </Text>
  );

  const header = (
    <>
      <Text style={[styles.title, TEXT_SHADOW, { fontSize: 13 * scale }]} numberOfLines={2}>
        {content.title}
      </Text>
      {!!content.subtitle && (
        <Text style={[styles.subtitle, TEXT_SHADOW, { fontSize: 11 * scale }]} numberOfLines={1}>
          {content.subtitle}
        </Text>
      )}
    </>
  );

  const renderCard = () => (
    <View ref={cardRef} collapsable={false} style={[styles.card, { width: cardW, height: cardH }]}>
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
            key={`${drawPath?.length ?? 0}-${drawPath?.[0]?.lat ?? 0}-${mapCenter ? "c" : "n"}`}
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
      ) : onPhoto ? (
        // Strava-style: just the numbers, the line and the wordmark,
        // floating on the picture in its upper half.
        <View style={[styles.centerStack, { paddingTop: 62 * scale }]} pointerEvents="none">
          {statBlock}
          {routeBlock}
          {wordmark}
        </View>
      ) : (
        <View style={[styles.centerStack, { paddingTop: 90 * scale }]} pointerEvents="none">
          {header}
          {statBlock}
          {routeBlock}
          {wordmark}
        </View>
      )}

      {loadingTrack && (
        <View style={styles.cardLoading}>
          <ActivityIndicator color={colors.cyan} />
        </View>
      )}
    </View>
  );

  // Screenshot mode: just the card, centred. Tap anywhere to come back.
  if (clean) {
    return (
      <Pressable style={styles.cleanWrap} onPress={() => setClean(false)}>
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

      {/* Which drive or track is on the card -- tap to pick another track. */}
      <Pressable style={styles.trackPick} onPress={openPicker} hitSlop={6}>
        <Text style={styles.trackPickLabel}>SHARING</Text>
        <Text style={styles.trackPickName} numberOfLines={1}>
          {content.title}
        </Text>
        <Text style={styles.trackPickChange}>CHOOSE TRACK</Text>
      </Pressable>

      <View style={[styles.cardWrap, { width: cardW, height: cardH }]}>{renderCard()}</View>

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
        <NeonButton label={canShareImage ? "SHARE" : "SCREENSHOT VIEW"} onPress={onShare} style={styles.shareButton} />
      )}
      {!canShareImage && (
        <Text style={styles.hint}>
          Shows just the card -- take a screenshot and post it. One-tap sharing and your own photos arrive with the
          next app update.
        </Text>
      )}

      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 12 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>SHARE WHICH TRACK?</Text>
              <Pressable onPress={() => setPickerOpen(false)} hitSlop={10}>
                <Text style={styles.closeText}>x</Text>
              </Pressable>
            </View>
            {/* Back to what you came here to share. */}
            {!route.params.trackId && (
              <Pressable
                style={styles.choiceRow}
                onPress={() => {
                  setPickerOpen(false);
                  setContent(fromDrive);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.choiceName}>{fromDrive.title}</Text>
                  <Text style={styles.choiceMeta}>What you opened this from</Text>
                </View>
              </Pressable>
            )}
            {choicesError ? (
              <Text style={styles.choiceError}>{choicesError}</Text>
            ) : !choices ? (
              <ActivityIndicator color={colors.cyan} style={{ marginVertical: 24 }} />
            ) : (
              <FlatList
                data={choices}
                keyExtractor={(c) => c.segment.id}
                style={{ maxHeight: winH * 0.55 }}
                ListEmptyComponent={<Text style={styles.choiceMeta}>No tracks yet.</Text>}
                renderItem={({ item }) => (
                  <Pressable
                    style={[styles.choiceRow, content.segmentId === item.segment.id && styles.choiceRowActive]}
                    onPress={() => chooseTrack(item.segment.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.choiceName} numberOfLines={1}>
                        {item.segment.name}
                      </Text>
                      <Text style={styles.choiceMeta}>
                        {formatDistanceLong(item.segment.lengthM, units, 2)}
                        {item.best
                          ? ` -- your best ${formatDuration(item.best.durationMs)}`
                          : item.segment.creatorId === user?.id
                          ? " -- your track"
                          : " -- not run yet"}
                      </Text>
                    </View>
                  </Pressable>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: "center" },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "stretch",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
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
  trackPick: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    gap: 8,
  },
  trackPickLabel: { color: colors.textMuted, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  trackPickName: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: "700" },
  trackPickChange: { color: colors.cyan, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  cardWrap: { borderRadius: 10, overflow: "hidden" },
  card: { overflow: "hidden", backgroundColor: colors.bg },
  cardLoading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  photoEmpty: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#10151d",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 40,
  },
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
  // The photo overlay reads like Strava's: a light label over a heavy number.
  photoLabel: { color: "#ffffff", fontWeight: "600" },
  photoValue: { color: "#ffffff", fontWeight: "900", letterSpacing: 0.3 },
  wordmark: { color: "#ffffff", fontFamily: fonts.display, letterSpacing: 3 },
  segment: { flexDirection: "row", gap: 8, marginTop: 12 },
  segmentOption: {
    borderWidth: 1,
    borderColor: colors.panelBorder,
    borderRadius: 16,
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  segmentOptionActive: { borderColor: colors.racePrimary, backgroundColor: colors.racePrimaryDim },
  segmentText: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  segmentTextActive: { color: colors.textPrimary },
  photoRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  photoButton: { borderWidth: 1, borderColor: colors.cyan, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 18 },
  photoButtonText: { color: colors.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  shareButton: { marginTop: 12, width: "80%" },
  hint: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 8, paddingHorizontal: 30 },
  cleanWrap: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: 1,
    borderColor: colors.panelBorder,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  modalTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 13, letterSpacing: 1.5 },
  choiceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  choiceRowActive: { backgroundColor: colors.racePrimaryDim },
  choiceName: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  choiceMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  choiceError: { color: colors.danger, fontSize: 13, marginVertical: 16 },
});
