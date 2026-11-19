package expo.modules.phantomoverlay

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

// The home-screen widget: a round NFS-style minimap button. Tapping it opens
// the app straight on the Minimap screen (phantomracing://minimap, handled
// in AppNavigator's MinimapDeepLink).
class MinimapWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("phantomracing://minimap"))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val pending = PendingIntent.getActivity(
      context,
      7301,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    for (id in appWidgetIds) {
      val views = RemoteViews(context.packageName, R.layout.phantom_minimap_widget)
      views.setOnClickPendingIntent(R.id.phantom_minimap_widget_root, pending)
      appWidgetManager.updateAppWidget(id, views)
    }
  }
}
