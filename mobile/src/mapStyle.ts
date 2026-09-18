// Google Maps JSON style for the Tron Legacy x Need for Speed look: a
// near-black basemap, muted road fills, and glowing cyan strokes on the
// road network (so streets read like a lit-up grid instead of a normal
// map). Points of interest and transit are turned off entirely -- on a
// racing app the road network IS the UI, and a map cluttered with
// restaurant/shop pins fights the HUD instead of supporting it.
//
// Passed to <MapView customMapStyle={tronMapStyle} /> (Google provider
// only -- this is Google's map-style JSON format, not a react-native-maps
// concept). Typed loosely (not the library's stricter MapStyleElement[])
// so this plain JSON literal doesn't have to satisfy every optional
// string-literal union in that type.
export const tronMapStyle: any[] = [
  { elementType: "geometry", stylers: [{ color: "#05070c" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7d93ab" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#05070c" }] },
  {
    featureType: "administrative",
    elementType: "geometry",
    stylers: [{ color: "#1c2b38" }, { weight: 1 }],
  },
  {
    featureType: "administrative.land_parcel",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "administrative.country",
    elementType: "labels.text.fill",
    stylers: [{ color: "#526279" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#7d93ab" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#080e16" }],
  },
  {
    featureType: "poi",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#0a1a16" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#101c28" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#173241" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#526279" }],
  },
  {
    featureType: "road.arterial",
    elementType: "geometry",
    stylers: [{ color: "#132330" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#16293a" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry.stroke",
    stylers: [{ color: "#2ce8f5" }, { weight: 1.1 }],
  },
  {
    featureType: "road.highway",
    elementType: "labels.text.fill",
    stylers: [{ color: "#2ce8f5" }],
  },
  {
    featureType: "road.highway",
    elementType: "labels.text.stroke",
    stylers: [{ color: "#05070c" }],
  },
  {
    featureType: "road.local",
    elementType: "geometry.stroke",
    stylers: [{ color: "#1c3444" }],
  },
  {
    featureType: "transit",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#020407" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#4d7dff" }],
  },
];
