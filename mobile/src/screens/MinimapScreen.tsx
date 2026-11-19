import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, AppState, Alert } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng, SegmentSummary } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
import { useFollowCamera } from "../hooks/useFollowCamera";
import { usePresenceHeartbeat, PresencePositionRef } from "../hooks/usePresenceHeartbeat";
import { useNearbyRacers } from "../hooks/useNearbyRacers";
import { CameraButton, CompassButton } from "../components/MapCameraButtons";
import MinimapFrame from "../components/MinimapFrame";
import VehicleMarker from "../components/VehicleMarker";
import { cleanSpeedKmh } from "../utils/speed";
import { displaySpeedKmh, speedUnit } from "../utils/units";
import { haversine, thinForDisplay } from "../utils/geo";
import { isHpMatch } from "../utils/car";
import { recordSpeed } from "../topSpeed";
import { feedTrackTimer } from "../trackTimer";
import {
  feedMinimap,
  setMinimapMarkers,
  setMinimapUnits,
  bubbleSupported,
  useBubble,
  setBubbleOn,
  canShowBubble,
  openBubblePermission,
} from "../minimap";
import {
  startBackgroundTracking,
  stopBackgroundTracking,
  requestBackgroundLocationPermission,
} from "../backgroundLocation";

type Props = NativeStackScreenProps<RootStackParamList, "Minimap">;

// Tracks this close to you are drawn on the minimap.
const TRACKS_NEAR_M = 8000;

// The round NFS-style minimap, full screen: the road around you through a
// glowing scope, heading-up, with other racers (gold when they're an HP
// match for you), the tracks near you, and your speed underneath. Opened
// from Home's radar button or the home-screen widget. From here you can
// also switch on the bubble: the same minimap floating over other apps
// while you drive (Android).
export default function MinimapScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { user, vehicleStyle, units } = useUser();
  const mapRef = useRef<MapView | null>(null);
  const camera = useFollowCamera(mapRef, { autoResumeMs: 4000 });
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [tracks, setTracks] = useState<SegmentSummary[]>([]);
  const presencePosRef: PresencePositionRef = useRef(null);
  usePresenceHeartbeat(presencePosRef);
  const racers = useNearbyRacers(presencePosRef, true);
  const bubble = useBubble();
  const waitingForPermission = useRef(false);

  useEffect(() => {
    setMinimapUnits(units === "imperial");
  }, [units]);

  // Your position, straight from the GPS while this screen is up.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (cancelled || perm.status !== "granted") return;
      try {
        const last = await Location.getLastKnownPositionAsync({});
        if (last && !cancelled) {
          const p = { lat: last.coords.latitude, lng: last.coords.longitude };
          setMyPos(p);
          camera.recenter(p);
        }
      } catch {}
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 3 },
        (loc) => {
          const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          const gpsHeading = loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : null;
          const kmh = cleanSpeedKmh(loc.coords.speed, loc.coords.accuracy);
          const course = camera.trackCourse(pos, gpsHeading, kmh);
          if (course != null) setHeading(course);
          setMyPos(pos);
          setSpeedKmh(kmh);
          presencePosRef.current = { coords: pos, heading: gpsHeading };
          camera.follow(pos);
          recordSpeed(kmh);
          feedTrackTimer({ lat: pos.lat, lng: pos.lng, t: loc.timestamp || Date.now(), speedKmh: kmh });
          feedMinimap({ lat: pos.lat, lng: pos.lng, heading: gpsHeading, speedKmh: kmh });
        }
      );
      if (cancelled) sub.remove();
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracks near you, drawn in gold.
  useEffect(() => {
    if (!user) return;
    api
      .listSegments(user.deviceId)
      .then(setTracks)
      .catch(() => {});
  }, [user]);
  const nearTracks = useMemo(() => {
    if (!myPos) return [];
    return tracks
      .filter((t) => Array.isArray(t.points) && t.points.length >= 2)
      .filter((t) => t.points.some((p, i) => i % 10 === 0 && haversine(p, myPos) < TRACKS_NEAR_M))
      .slice(0, 30)
      .map((t) => ({ id: t.id, coords: thinForDisplay(t.points, 300).map((p) => ({ latitude: p.lat, longitude: p.lng })) }));
    // Recomputed when you've moved a fair way, not on every fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, myPos ? Math.round(myPos.lat * 50) : 0, myPos ? Math.round(myPos.lng * 50) : 0]);

  // The bubble shows the same racers.
  useEffect(() => {
    setMinimapMarkers(
      racers.map((r) => ({ lat: r.lat, lng: r.lng, kind: isHpMatch(user?.car, r.car) ? "match" : "racer" }))
    );
  }, [racers, user?.car]);

  const enableBubble = async () => {
    await requestBackgroundLocationPermission().catch(() => false);
    try {
      // Keeps GPS going in the background so the bubble can follow you.
      await startBackgroundTracking("Minimap bubble is on -- tap to return to Phantom Racing.", "minimap");
    } catch {}
    setBubbleOn(true);
  };

  // Back from the "display over other apps" settings page: finish turning
  // the bubble on if it was allowed.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && waitingForPermission.current) {
        waitingForPermission.current = false;
        if (canShowBubble()) enableBubble();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleBubble = () => {
    if (bubble) {
      setBubbleOn(false);
      stopBackgroundTracking("minimap").catch(() => {});
      return;
    }
    if (canShowBubble()) {
      enableBubble();
      return;
    }
    Alert.alert(
      "Minimap over other apps",
      'To float the minimap over other apps (maps, music...), allow Phantom Racing to "Display over other apps" on the next screen, then come back.',
      [
        { text: "Not now", style: "cancel" },
        {
          text: "Allow",
          onPress: () => {
            waitingForPermission.current = true;
            openBubblePermission();
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        showsCompass={false}
        toolbarEnabled={false}
        {...camera.mapProps}
        initialRegion={
          myPos ? { latitude: myPos.lat, longitude: myPos.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 } : undefined
        }
      >
        {nearTracks.map((t) => (
          <Polyline key={t.id} coordinates={t.coords} strokeColor={colors.gold} strokeWidth={4} />
        ))}
        {racers.map((r) => {
          const match = isHpMatch(user?.car, r.car);
          return (
            <Marker
              key={r.deviceId}
              coordinate={{ latitude: r.lat, longitude: r.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              rotation={r.heading ?? 0}
              flat={r.heading != null}
              tracksViewChanges={false}
              zIndex={5}
              onPress={() => navigation.navigate("Home", { challenge: r.deviceId })}
            >
              <VehicleMarker vehicleStyle="arrow" size={26} color={match ? colors.gold : colors.racePrimary} />
            </Marker>
          );
        })}
        {myPos && (
          <Marker
            coordinate={{ latitude: myPos.lat, longitude: myPos.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={heading}
            flat
            tracksViewChanges={false}
            zIndex={10}
          >
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
      </MapView>
      <MinimapFrame headingDeg={camera.mode === "heading" ? heading : 0} sizeRatio={0.86} />

      <View style={[styles.topRow, { top: insets.top + 10 }]}>
        <Pressable style={styles.close} onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={styles.closeText}>x</Text>
        </Pressable>
        <Text style={styles.title}>MINIMAP</Text>
        <View style={{ width: 36 }} />
      </View>
      <Text style={[styles.legend, { top: insets.top + 54 }]}>
        <Text style={{ color: colors.racePrimary }}>{"▲"} </Text>racers{"   "}
        <Text style={{ color: colors.gold }}>{"▲"} </Text>HP match{"   "}
        <Text style={{ color: colors.gold }}>{"—"} </Text>tracks
      </Text>

      <View style={styles.sideButtons} pointerEvents="box-none">
        <CompassButton mode={camera.mode} onPress={camera.toggleMode} style={{ marginBottom: 10 }} />
        <CameraButton viewLabel={camera.viewLabel} onPress={camera.cycleView} />
      </View>

      {/* Speed, NFS style, under the scope. */}
      <View style={[styles.speedBlock, { bottom: insets.bottom + (bubbleSupported ? 104 : 40) }]} pointerEvents="none">
        <Text style={styles.speed}>{displaySpeedKmh(speedKmh, units)}</Text>
        <Text style={styles.speedUnit}>{speedUnit(units).toUpperCase()}</Text>
      </View>

      {bubbleSupported && (
        <Pressable
          style={[styles.bubbleToggle, bubble && styles.bubbleToggleOn, { bottom: insets.bottom + 24 }]}
          onPress={toggleBubble}
        >
          <View style={[styles.bubbleDot, bubble && styles.bubbleDotOn]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.bubbleTitle, bubble && { color: colors.cyan }]}>
              {bubble ? "BUBBLE ON" : "FLOAT OVER OTHER APPS"}
            </Text>
            <Text style={styles.bubbleSub}>
              {bubble
                ? "Leave the app and the minimap follows you. Tap it to come back, hold it to hide it."
                : "Keep this minimap on screen while you use other apps."}
            </Text>
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topRow: { position: "absolute", left: 16, right: 16, flexDirection: "row", alignItems: "center" },
  close: { ...panelStyle, width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  closeText: { color: colors.textPrimary, fontSize: 16, fontWeight: "800" },
  title: {
    flex: 1,
    textAlign: "center",
    color: colors.cyan,
    fontFamily: fonts.display,
    fontSize: 18,
    letterSpacing: 4,
  },
  legend: { position: "absolute", left: 0, right: 0, textAlign: "center", color: colors.textSecondary, fontSize: 11 },
  sideButtons: { position: "absolute", right: 16, top: "18%" },
  speedBlock: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  speed: { color: colors.textPrimary, fontFamily: fonts.display, fontSize: 56, lineHeight: 62, fontStyle: "italic" },
  speedUnit: { color: colors.cyan, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 3 },
  bubbleToggle: {
    position: "absolute",
    left: 16,
    right: 16,
    ...panelStyle,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  bubbleToggleOn: { borderColor: colors.cyan, backgroundColor: colors.cyanDim },
  bubbleDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: colors.textSecondary },
  bubbleDotOn: { borderColor: colors.cyan, backgroundColor: colors.cyan },
  bubbleTitle: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5 },
  bubbleSub: { color: colors.textSecondary, fontSize: 11, marginTop: 3 },
});
