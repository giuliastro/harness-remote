package ai.harness.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;

/** The persistent, low-priority notification Android requires for the foreground service. */
final class BackgroundAttentionNotifications {
    static final String SERVICE_CHANNEL_ID = "harness_remote_background_service";
    static final int SERVICE_NOTIFICATION_ID = 7412;

    private BackgroundAttentionNotifications() {}

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(SERVICE_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            SERVICE_CHANNEL_ID,
            context.getString(R.string.hr_bg_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(context.getString(R.string.hr_bg_channel_description));
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    /**
     * Open the app the way its launcher icon does: an already running app is brought to the front
     * exactly as it was, and only a cold start loads it. Clearing the task here made every tap,
     * even with the app open, restart the WebView and reload every Session. A WebView whose renderer
     * the system killed is rebuilt by MainActivity instead.
     */
    static Intent resumeAppIntent(Context context) {
        return new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
    }

    static Notification buildServiceNotification(Context context, int connected, int configured) {
        String text;
        if (configured <= 0) {
            text = context.getString(R.string.hr_bg_no_machines);
        } else if (connected > 0) {
            text = context.getResources().getQuantityString(R.plurals.hr_bg_connected_machines, connected, connected);
        } else {
            text = context.getResources().getQuantityString(R.plurals.hr_bg_connecting_machines, configured, configured);
        }

        Intent open = resumeAppIntent(context);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, 0, open, pendingFlags);
        Intent stop = new Intent(context, BackgroundAttentionService.class)
            .setAction(BackgroundAttentionService.ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(context, 1, stop, pendingFlags);
        Notification.Action stopAction = new Notification.Action.Builder(
            Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel),
            context.getString(R.string.hr_bg_stop),
            stopIntent
        ).build();

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, SERVICE_CHANNEL_ID)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(R.drawable.ic_stat_harness)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(stopAction);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }
}
