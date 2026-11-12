package ai.harness.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.HashSet;
import java.util.Set;

/**
 * A visible alert when a paired machine stops answering while the app is in the background. The
 * session outcome stream cannot emit a terminal edge if the machine never delivers it; this is the
 * only honest notification for that case.
 */
final class MachineAlertCenter {
    private static final String CHANNEL_ID = "harness_remote_machine_connection";
    private static final int NOTIFICATION_BASE = 7600;

    private final Context context;
    private final NotificationManager manager;
    private final Set<String> activeMachines = new HashSet<>();

    MachineAlertCenter(Context context) {
        this.context = context.getApplicationContext();
        this.manager = (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
        ensureChannel();
    }

    synchronized void show(String machineID, String machineName, String baseUrl) {
        if (manager == null || machineID == null || machineID.isEmpty()) return;
        int id = notificationID(machineID);
        Intent open = BackgroundAttentionNotifications.resumeAppIntent(context);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, id, open, pendingFlags);

        String name = machineName == null || machineName.trim().isEmpty() ? machineID : machineName.trim();
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(R.drawable.ic_stat_harness)
            .setContentTitle(context.getString(R.string.hr_bg_unreachable_title))
            .setContentText(context.getString(R.string.hr_bg_unreachable_body, name, baseUrl == null ? "" : baseUrl))
            .setStyle(new Notification.BigTextStyle().bigText(context.getString(R.string.hr_bg_unreachable_body, name, baseUrl == null ? "" : baseUrl)))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_ERROR)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setWhen(System.currentTimeMillis());
        try {
            manager.notify(id, builder.build());
            activeMachines.add(machineID);
        } catch (SecurityException ignored) {
            // The notification permission may have been revoked after the service started.
        }
    }

    synchronized void clear(String machineID) {
        if (manager == null || machineID == null || machineID.isEmpty()) return;
        manager.cancel(notificationID(machineID));
        activeMachines.remove(machineID);
    }

    synchronized void clearAll() {
        if (manager == null) return;
        for (String machineID : new HashSet<>(activeMachines)) manager.cancel(notificationID(machineID));
        activeMachines.clear();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.hr_bg_unreachable_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(context.getString(R.string.hr_bg_unreachable_channel_description));
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    private static int notificationID(String machineID) {
        return NOTIFICATION_BASE + (machineID.hashCode() & 0x7fffffff) % 1000;
    }
}
