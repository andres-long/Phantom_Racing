import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Marker } from "react-native-maps";
import { PresenceUser, RaceChallenge } from "../types";
import { colors, fonts, panelStyle } from "../theme";
import VehicleMarker from "./VehicleMarker";
import NeonButton from "./NeonButton";

// Other racers on the map while you're driving -- the same arrow + name
// badge Home uses. Must be rendered inside a <MapView>. Tapping one hands
// that racer to the screen, which offers to race them.
export function RacerMarkers({
  racers,
  onSelect,
}: {
  racers: PresenceUser[];
  onSelect: (racer: PresenceUser) => void;
}) {
  return (
    <>
      {racers.map((u) => (
        <Marker
          key={u.deviceId}
          // Above your own marker: side by side, yours would otherwise
          // swallow the tap (same fix as Home's).
          zIndex={5}
          coordinate={{ latitude: u.lat, longitude: u.lng }}
          anchor={{ x: 0.5, y: 0.5 }}
          rotation={u.heading ?? 0}
          flat={u.heading != null}
          tracksViewChanges={false}
          onPress={() => onSelect(u)}
        >
          <View style={styles.wrap}>
            <VehicleMarker vehicleStyle="arrow" size={28} color={colors.racePrimary} />
            <View style={styles.label}>
              <Text style={styles.labelText} numberOfLines={1}>
                {u.displayName}
              </Text>
            </View>
          </View>
        </Marker>
      ))}
    </>
  );
}

// "X wants to race you" while you're in the middle of a drive. Accepting
// starts the race on top of whatever you're recording, which keeps going.
export function IncomingRaceCard({
  race,
  busy,
  onAccept,
  onDecline,
  style,
}: {
  race: RaceChallenge;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  style?: object;
}) {
  return (
    <View style={[styles.card, style]}>
      <Text style={styles.title}>Race request!</Text>
      <Text style={styles.meta}>
        {race.opponentDisplayName} wants to race you -- {race.distanceLabel} {race.directionLabel}. Your recording
        keeps going while you race.
      </Text>
      <View style={styles.actions}>
        <NeonButton label="ACCEPT" onPress={onAccept} disabled={busy} style={styles.button} />
        <NeonButton label="DECLINE" variant="outline" onPress={onDecline} disabled={busy} style={styles.button} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  label: {
    backgroundColor: "#000000dd",
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: colors.racePrimary,
    maxWidth: 120,
    marginTop: 2,
  },
  labelText: { color: colors.textPrimary, fontSize: 10, fontWeight: "700" },
  card: {
    position: "absolute",
    left: 16,
    right: 16,
    ...panelStyle,
    padding: 16,
    borderColor: colors.racePrimary,
  },
  title: { color: colors.textPrimary, fontFamily: fonts.heading, fontSize: 16, marginBottom: 6 },
  meta: { color: colors.textSecondary, fontSize: 13 },
  actions: { flexDirection: "row", marginTop: 14, gap: 10 },
  button: { flex: 1 },
});
