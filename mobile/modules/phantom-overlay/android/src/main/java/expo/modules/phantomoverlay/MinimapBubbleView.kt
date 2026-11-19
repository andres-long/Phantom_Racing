package expo.modules.phantomoverlay

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.view.View
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

// The bubble: an NFS-style round minimap drawn by hand -- dark scope,
// glowing cyan rim, the line you're following in gold, racers as dots,
// your arrow in the middle pointing up (the map turns with you), a red N on
// the rim, and your speed at the bottom. Zooms out as you go faster.
class MinimapBubbleView(context: Context) : View(context) {
  private val density = context.resources.displayMetrics.density
  private fun dp(v: Float) = v * density

  private val cyan = Color.parseColor("#2CE8F5")
  private val gold = Color.parseColor("#FFCF3D")
  private val red = Color.parseColor("#FF5023")

  private val disk = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#EE070B12") }
  private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(7f)
    color = Color.argb(110, 44, 232, 245)
    maskFilter = BlurMaskFilter(dp(5f), BlurMaskFilter.Blur.NORMAL)
  }
  private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(2.5f)
    color = cyan
  }
  private val faint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(1f)
    color = Color.argb(50, 44, 232, 245)
  }
  private val tick = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(1.5f)
    color = Color.argb(170, 44, 232, 245)
  }
  private val route = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(3.5f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    color = gold
  }
  private val trail = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(2f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    color = Color.argb(150, 44, 232, 245)
  }
  private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
  private val dotRing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(1.5f)
    color = Color.parseColor("#05070C")
  }
  private val arrowFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#EEF6FF") }
  private val arrowEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(1.5f)
    strokeJoin = Paint.Join.ROUND
    color = cyan
  }
  private val nBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#05070C") }
  private val nRing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = dp(1.5f)
    color = red
  }
  private val nText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = red
    textSize = dp(10f)
    typeface = Typeface.DEFAULT_BOLD
    textAlign = Paint.Align.CENTER
  }
  private val speedText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    textSize = dp(20f)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD_ITALIC)
    textAlign = Paint.Align.CENTER
  }
  private val unitText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = cyan
    textSize = dp(8f)
    typeface = Typeface.DEFAULT_BOLD
    textAlign = Paint.Align.CENTER
    letterSpacing = 0.2f
  }
  private val waitText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(200, 125, 147, 171)
    textSize = dp(9f)
    textAlign = Paint.Align.CENTER
  }
  private val clip = Path()
  private val path = Path()

  init {
    // The blur glow needs software drawing.
    setLayerType(LAYER_TYPE_SOFTWARE, null)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    val cx = w / 2f
    val cy = h / 2f
    val r = min(w, h) / 2f - dp(10f)

    canvas.drawCircle(cx, cy, r, disk)

    val s = MinimapState
    canvas.save()
    clip.reset()
    clip.addCircle(cx, cy, r, Path.Direction.CW)
    canvas.clipPath(clip)
    canvas.drawCircle(cx, cy, r * 0.5f, faint)
    canvas.drawLine(cx - r, cy, cx + r, cy, faint)
    canvas.drawLine(cx, cy - r, cx, cy + r, faint)

    if (s.hasPosition) {
      // Zoom: ~250 m to the rim when slow, out to ~1 km at speed.
      val kmh = if (s.unit == "mph") s.speed / 0.621371 else s.speed
      val rangeM = max(250.0, min(1000.0, 200.0 + kmh * 6.0))
      val pxPerM = (r * 0.92) / rangeM
      val h0 = Math.toRadians(s.headingDeg)
      val cosH = cos(h0)
      val sinH = sin(h0)
      val cosLat = cos(Math.toRadians(s.lat))
      val lat0 = s.lat
      val lng0 = s.lng

      // Screen position of a point: heading-up around you.
      fun sx(lat: Double, lng: Double): Float {
        val dx = (lng - lng0) * 111320.0 * cosLat
        val dy = (lat - lat0) * 110540.0
        return (cx + (dx * cosH - dy * sinH) * pxPerM).toFloat()
      }
      fun sy(lat: Double, lng: Double): Float {
        val dx = (lng - lng0) * 111320.0 * cosLat
        val dy = (lat - lat0) * 110540.0
        return (cy - (dx * sinH + dy * cosH) * pxPerM).toFloat()
      }

      val lats = s.routeLats
      val lngs = s.routeLngs
      val n = min(lats.size, lngs.size)
      if (n >= 2) {
        path.reset()
        var started = false
        for (i in 0 until n) {
          val x = sx(lats[i], lngs[i])
          val y = sy(lats[i], lngs[i])
          if (!started) {
            path.moveTo(x, y)
            started = true
          } else path.lineTo(x, y)
        }
        canvas.drawPath(path, route)
      }

      val mLats = s.markerLats
      val mLngs = s.markerLngs
      val kinds = s.markerKinds
      val m = min(mLats.size, min(mLngs.size, kinds.size))
      for (i in 0 until m) {
        val x = sx(mLats[i], mLngs[i])
        val y = sy(mLats[i], mLngs[i])
        dot.color = when (kinds[i]) {
          1 -> gold
          2 -> Color.WHITE
          else -> red
        }
        canvas.drawCircle(x, y, dp(4.5f), dot)
        canvas.drawCircle(x, y, dp(4.5f), dotRing)
      }
    }
    canvas.restore()

    // Rim, glow and ticks.
    canvas.drawCircle(cx, cy, r, glow)
    canvas.drawCircle(cx, cy, r, rim)
    for (i in 0 until 12) {
      val a = Math.toRadians(i * 30.0)
      val r1 = r - dp(if (i % 3 == 0) 7f else 4f)
      canvas.drawLine(
        (cx + cos(a) * r1).toFloat(), (cy + sin(a) * r1).toFloat(),
        (cx + cos(a) * r).toFloat(), (cy + sin(a) * r).toFloat(),
        tick
      )
    }

    // You.
    path.reset()
    val a = dp(9f)
    path.moveTo(cx, cy - a)
    path.lineTo(cx + a * 0.75f, cy + a * 0.85f)
    path.lineTo(cx, cy + a * 0.4f)
    path.lineTo(cx - a * 0.75f, cy + a * 0.85f)
    path.close()
    canvas.drawPath(path, arrowFill)
    canvas.drawPath(path, arrowEdge)

    // North swings round the rim as you turn.
    val nA = Math.toRadians(-s.headingDeg - 90.0)
    val nx = (cx + cos(nA) * r).toFloat()
    val ny = (cy + sin(nA) * r).toFloat()
    canvas.drawCircle(nx, ny, dp(7.5f), nBg)
    canvas.drawCircle(nx, ny, dp(7.5f), nRing)
    canvas.drawText("N", nx, ny + dp(3.5f), nText)

    // Speed.
    if (s.hasPosition) {
      canvas.drawText(s.speed.roundToInt().toString(), cx, cy + r * 0.62f, speedText)
      canvas.drawText(s.unit.uppercase(), cx, cy + r * 0.62f + dp(10f), unitText)
    } else {
      canvas.drawText("WAITING FOR GPS", cx, cy + r * 0.6f, waitText)
    }
  }
}
