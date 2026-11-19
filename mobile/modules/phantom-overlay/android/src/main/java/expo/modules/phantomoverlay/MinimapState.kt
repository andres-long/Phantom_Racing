package expo.modules.phantomoverlay

// What the bubble draws. Written from the JS thread, read on the UI thread.
object MinimapState {
  @Volatile var lat = 0.0
  @Volatile var lng = 0.0
  @Volatile var hasPosition = false
  @Volatile var headingDeg = 0.0
  @Volatile var speed = 0.0
  @Volatile var unit = "km/h"
  @Volatile var routeLats = DoubleArray(0)
  @Volatile var routeLngs = DoubleArray(0)
  @Volatile var markerLats = DoubleArray(0)
  @Volatile var markerLngs = DoubleArray(0)
  @Volatile var markerKinds = IntArray(0)

  fun update(lat: Double, lng: Double, headingDeg: Double, speed: Double, unit: String) {
    this.lat = lat
    this.lng = lng
    this.headingDeg = headingDeg
    this.speed = speed
    this.unit = unit
    hasPosition = true
  }

  fun setRoute(lats: List<Double>, lngs: List<Double>) {
    val n = minOf(lats.size, lngs.size)
    // Swap both at once (lngs first, so a reader never sees new lats with
    // old, shorter lngs -- the view also bounds-checks).
    routeLngs = DoubleArray(n) { lngs[it] }
    routeLats = DoubleArray(n) { lats[it] }
  }

  fun setMarkers(lats: List<Double>, lngs: List<Double>, kinds: List<Int>) {
    val n = minOf(lats.size, lngs.size, kinds.size)
    markerKinds = IntArray(n) { kinds[it] }
    markerLngs = DoubleArray(n) { lngs[it] }
    markerLats = DoubleArray(n) { lats[it] }
  }
}
