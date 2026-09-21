import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, FlatList, ActivityIndicator, Alert } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, LatLng, PlacePrediction, PlaceDetails, DirectionsResponse } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { formatDistanceShort } from "../utils/units";
import { colors, fonts, panelStyle } from "../theme";
import { tronMapStyle } from "../mapStyle";
import NeonButton from "../components/NeonButton";
import VehicleMarker from "../components/VehicleMarker";

type Props = NativeStackScreenProps<RootStackParamList, "GoTo">;

// "Search a place, see the route" -- one screen, two stages. Stage 1 is a
// plain text search (a business name, an address, an intersection) against
// Google Places, biased toward wherever you are right now. Picking a result
// fetches a real driving route + ETA from Google Directions and flips to
// stage 2: a map preview of that route, with a START button that hands off
// to GoRaceScreen for the actual tracked, live-rerouting drive.
export default function GoToScreen({ navigation }: Props) {
  const { vehicleStyle, units } = useUser();
  const insets = useSafeAreaInsets();

  const mapRef = useRef<MapView | null>(null);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [query, setQuery] = useState("");
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [destination, setDestination] = useState<PlaceDetails | null>(null);
  const [directions, setDirections] = useState<DirectionsResponse | null>(null);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTokenRef = useRef(0);

  useEffect(() => {
    // The map's initialRegion is only read once, at mount, so we hold the
    // map off-screen (locationReady stays false) until we have SOME fix to
    // seed it with -- otherwise it bakes in a hardcoded fallback and never
    // recovers. getLastKnownPositionAsync returns a cached fix almost
    // instantly, which is enough to open the map in the right place; a
    // fresh getCurrentPositionAsync fix follows right after to refine it.
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!cancelled) setLocationReady(true);
        return;
      }
      try {
        const last = await Location.getLastKnownPositionAsync({});
        if (last && !cancelled) {
          setMyPos({ lat: last.coords.latitude, lng: last.coords.longitude });
          setLocationReady(true);
        }
      } catch {}
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) {
          setMyPos({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          setLocationReady(true);
        }
      } catch {
        // No fix yet -- search still works, it just won't be location-biased
        // until one comes in, and Start will re-check before racing.
        if (!cancelled) setLocationReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChangeQuery = (text: string) => {
    setQuery(text);
    setSearchError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) {
      setPredictions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const token = ++searchTokenRef.current;
      setSearching(true);
      try {
        const { predictions: results } = await api.placesAutocomplete(text.trim(), myPos ?? undefined);
        if (token === searchTokenRef.current) setPredictions(results);
      } catch (e: any) {
        if (token === searchTokenRef.current) setSearchError(e.message || "Search failed.");
      } finally {
        if (token === searchTokenRef.current) setSearching(false);
      }
    }, 350);
  };

  // Shared by both ways of picking a destination -- searching a place, or
  // tapping a spot on the map -- once we already have a PlaceDetails-shaped
  // object to route to.
  const startRouting = async (place: PlaceDetails) => {
    setRouteError(null);
    setLoadingRoute(true);
    setDestination(place);
    try {
      let origin = myPos;
      if (!origin) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          origin = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          setMyPos(origin);
        }
      }
      if (!origin) {
        setRouteError("Can't find a route without your location -- enable location access and try again.");
        return;
      }

      const route = await api.getDirections(origin, { lat: place.lat, lng: place.lng });
      setDirections(route);
      if (route.points.length > 1) {
        setTimeout(() => {
          mapRef.current?.fitToCoordinates(
            route.points.map((p) => ({ latitude: p.lat, longitude: p.lng })),
            { edgePadding: { top: 80, right: 60, bottom: 260, left: 60 }, animated: true }
          );
        }, 200);
      }
    } catch (e: any) {
      setRouteError(e.message || "Couldn't find a route there.");
    } finally {
      setLoadingRoute(false);
    }
  };

  const selectPrediction = async (prediction: PlacePrediction) => {
    setRouteError(null);
    setLoadingRoute(true);
    try {
      const place = await api.placeDetails(prediction.placeId);
      await startRouting(place);
    } catch (e: any) {
      setRouteError(e.message || "Couldn't find a route there.");
      setLoadingRoute(false);
    }
  };

  // Tap-to-pick: press anywhere on the map to route there directly, no
  // typing needed. We don't have reverse geocoding wired up, so the picked
  // spot shows as a plain coordinate rather than a place name/address.
  const pickOnMap = (coordinate: { latitude: number; longitude: number }) => {
    if (preview) return;
    const place: PlaceDetails = {
      placeId: `pin_${coordinate.latitude.toFixed(6)},${coordinate.longitude.toFixed(6)}`,
      name: "Dropped pin",
      address: `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`,
      lat: coordinate.latitude,
      lng: coordinate.longitude,
    };
    setPredictions([]);
    setQuery("");
    startRouting(place);
  };

  const changeDestination = () => {
    setDestination(null);
    setDirections(null);
    setRouteError(null);
  };

  const start = async () => {
    if (!destination || !directions || !myPos) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Location permission needed", "Can't track a drive without location access.");
      return;
    }
    navigation.replace("GoRace", {
      destinationName: destination.name || destination.address,
      destination: { lat: destination.lat, lng: destination.lng },
      route: directions.points,
      distanceM: directions.distanceM,
      durationS: directions.durationS,
    });
  };

  const formatEta = (durationS: number) => {
    const totalMin = Math.round(durationS / 60);
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  };

  const formatDistance = (m: number) => formatDistanceShort(m, units);

  // A combined value (rather than a plain boolean flag) so TypeScript can
  // narrow `destination`/`directions` to non-null wherever `preview` is
  // truthy below, instead of needing a non-null assertion at every use.
  const preview = destination && directions ? { destination, directions } : null;

  if (!locationReady) {
    return (
      <View style={[styles.container, styles.mapLoading]}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={tronMapStyle}
        initialRegion={{
          latitude: myPos?.lat ?? 14.6349,
          longitude: myPos?.lng ?? -90.5069,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
        onPress={(e) => pickOnMap(e.nativeEvent.coordinate)}
      >
        {myPos && (
          <Marker coordinate={{ latitude: myPos.lat, longitude: myPos.lng }} anchor={{ x: 0.5, y: 0.5 }} flat tracksViewChanges={false}>
            <VehicleMarker vehicleStyle={vehicleStyle} />
          </Marker>
        )}
        {preview && (
          <>
            <Polyline
              coordinates={preview.directions.points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
              strokeColor={colors.cyan}
              strokeWidth={5}
            />
            <Marker
              coordinate={{ latitude: preview.destination.lat, longitude: preview.destination.lng }}
              title={preview.destination.name}
              pinColor={colors.gold}
            />
          </>
        )}
      </MapView>

      <Pressable
        style={[styles.cancelButton, { top: insets.top + 10 }]}
        onPress={() => navigation.goBack()}
        hitSlop={10}
      >
        <Text style={styles.cancelText}>x</Text>
      </Pressable>

      {!preview ? (
        <View style={[styles.searchPanel, { top: insets.top + 60 }]}>
          <Text style={styles.title}>GO TO</Text>
          <Text style={styles.hint}>Search a place, or just tap a spot on the map</Text>
          <TextInput
            style={styles.input}
            placeholder="A place, address, or intersection"
            placeholderTextColor={colors.textMuted}
            value={query}
            onChangeText={onChangeQuery}
            autoFocus
            autoCorrect={false}
          />
          {searching && <ActivityIndicator color={colors.cyan} style={{ marginTop: 10 }} />}
          {loadingRoute && (
            <View style={styles.routeLoading}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.routeLoadingText}>Finding the route...</Text>
            </View>
          )}
          {searchError && <Text style={styles.errorText}>{searchError}</Text>}
          {routeError && <Text style={styles.errorText}>{routeError}</Text>}
          {!loadingRoute && (
            <FlatList
              data={predictions}
              keyExtractor={(item) => item.placeId}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable style={styles.predictionRow} onPress={() => selectPrediction(item)}>
                  <Text style={styles.predictionText} numberOfLines={2}>
                    {item.description}
                  </Text>
                </Pressable>
              )}
            />
          )}
        </View>
      ) : (
        <View style={styles.previewPanel}>
          <Text style={styles.destName} numberOfLines={2}>
            {preview.destination.name}
          </Text>
          <Text style={styles.destAddress} numberOfLines={1}>
            {preview.destination.address}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.metaValue}>{formatEta(preview.directions.durationS)}</Text>
            <Text style={styles.metaLabel}>{formatDistance(preview.directions.distanceM)} away</Text>
          </View>
          <View style={styles.previewActions}>
            <NeonButton label="START" onPress={start} style={styles.previewButton} />
            <NeonButton label="CHANGE" variant="outline" onPress={changeDestination} style={styles.previewButton} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  mapLoading: { alignItems: "center", justifyContent: "center" },
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
    zIndex: 2,
  },
  cancelText: { color: colors.cyan, fontSize: 16, fontWeight: "800" },
  searchPanel: {
    position: "absolute",
    left: 20,
    right: 20,
    ...panelStyle,
    padding: 16,
    maxHeight: "70%",
  },
  title: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5, marginBottom: 10 },
  hint: { color: colors.textMuted, fontSize: 11, marginTop: -6, marginBottom: 10 },
  input: {
    backgroundColor: colors.bgElevated,
    color: colors.textPrimary,
    padding: 14,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  list: { marginTop: 10 },
  predictionRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider },
  predictionText: { color: colors.textPrimary, fontSize: 14 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: 10 },
  routeLoading: { flexDirection: "row", alignItems: "center", marginTop: 10, gap: 8 },
  routeLoadingText: { color: colors.textSecondary, fontSize: 12 },
  previewPanel: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 30,
    ...panelStyle,
    padding: 18,
  },
  destName: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 17 },
  destAddress: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  metaRow: { flexDirection: "row", alignItems: "baseline", marginTop: 12, gap: 10 },
  metaValue: { color: colors.cyan, fontFamily: fonts.display, fontSize: 26 },
  metaLabel: { color: colors.textSecondary, fontSize: 13 },
  previewActions: { flexDirection: "row", gap: 10, marginTop: 16 },
  previewButton: { flex: 1 },
});
