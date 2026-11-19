package expo.modules.phantomoverlay

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.WindowManager
import kotlin.math.abs

// Adds / removes the bubble window. Everything on the main thread.
object OverlayController {
  private val main = Handler(Looper.getMainLooper())
  private var view: MinimapBubbleView? = null
  private var windowManager: WindowManager? = null
  private var params: WindowManager.LayoutParams? = null
  // Where it was last dragged to, kept for next time.
  private var lastX = -1
  private var lastY = -1

  fun isShowing(): Boolean = view != null

  fun show(context: Context) {
    main.post {
      if (view != null) return@post
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) return@post
      val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
      val density = context.resources.displayMetrics.density
      val size = (156 * density).toInt()
      @Suppress("DEPRECATION")
      val type =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else WindowManager.LayoutParams.TYPE_PHONE
      val p = WindowManager.LayoutParams(
        size,
        size,
        type,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT
      )
      p.gravity = Gravity.TOP or Gravity.START
      val screenW = context.resources.displayMetrics.widthPixels
      p.x = if (lastX >= 0) lastX else screenW - size - (12 * density).toInt()
      p.y = if (lastY >= 0) lastY else (120 * density).toInt()
      val v = MinimapBubbleView(context)
      attachTouch(context, v, wm, p)
      try {
        wm.addView(v, p)
        view = v
        windowManager = wm
        params = p
      } catch (e: Exception) {
        // No permission after all, or the window manager said no.
      }
    }
  }

  fun hide() {
    main.post {
      val v = view ?: return@post
      try {
        windowManager?.removeView(v)
      } catch (e: Exception) {
      }
      view = null
    }
  }

  fun redraw() {
    main.post { view?.invalidate() }
  }

  // Drag it anywhere; tap to go back to the app; hold to hide it (it comes
  // back next time you leave the app).
  @SuppressLint("ClickableViewAccessibility")
  private fun attachTouch(context: Context, v: MinimapBubbleView, wm: WindowManager, p: WindowManager.LayoutParams) {
    val slop = ViewConfiguration.get(context).scaledTouchSlop
    val longPressMs = ViewConfiguration.getLongPressTimeout().toLong()
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false
    var longPressed = false
    val longPress = Runnable {
      if (!moved) {
        longPressed = true
        hide()
      }
    }
    v.setOnTouchListener { _, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = e.rawX
          downY = e.rawY
          startX = p.x
          startY = p.y
          moved = false
          longPressed = false
          main.postDelayed(longPress, longPressMs)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - downX
          val dy = e.rawY - downY
          if (!moved && (abs(dx) > slop || abs(dy) > slop)) {
            moved = true
            main.removeCallbacks(longPress)
          }
          if (moved && view != null) {
            p.x = startX + dx.toInt()
            p.y = startY + dy.toInt()
            lastX = p.x
            lastY = p.y
            try {
              wm.updateViewLayout(v, p)
            } catch (ex: Exception) {
            }
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          main.removeCallbacks(longPress)
          if (!moved && !longPressed) openApp(context)
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(longPress)
          true
        }
        else -> false
      }
    }
  }

  private fun openApp(context: Context) {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
    try {
      context.startActivity(intent)
    } catch (e: Exception) {
    }
  }
}
