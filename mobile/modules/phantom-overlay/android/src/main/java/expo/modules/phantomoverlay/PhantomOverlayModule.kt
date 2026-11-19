package expo.modules.phantomoverlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// JS side: mobile/src/native/phantomOverlay.ts. The minimap bubble that
// floats over other apps (drawn natively, see MinimapBubbleView) and is fed
// from JS with your position, the line you're following and nearby racers.
class PhantomOverlayModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is gone" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("PhantomOverlay")

    Function("canDrawOverlays") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)
    }

    Function("openOverlaySettings") {
      val intent = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:" + context.packageName)
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("show") {
      OverlayController.show(context)
    }

    Function("hide") {
      OverlayController.hide()
    }

    Function("isShowing") {
      OverlayController.isShowing()
    }

    Function("update") { lat: Double, lng: Double, headingDeg: Double, speed: Double, unit: String ->
      MinimapState.update(lat, lng, headingDeg, speed, unit)
      OverlayController.redraw()
    }

    Function("setRoute") { lats: List<Double>, lngs: List<Double> ->
      MinimapState.setRoute(lats, lngs)
      OverlayController.redraw()
    }

    Function("setMarkers") { lats: List<Double>, lngs: List<Double>, kinds: List<Int> ->
      MinimapState.setMarkers(lats, lngs, kinds)
      OverlayController.redraw()
    }
  }
}
