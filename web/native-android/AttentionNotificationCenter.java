package ai.harness.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Posts permission/question Attention notifications for the background service. It owns a bounded
 * dedupe cache, never answers or resolves a native request, and cancels a notification when the
 * harness reports that the same request was replied to or rejected.
 */
final class AttentionNotificationCenter {
    static final String ATTENTION_CHANNEL_ID = "harness_remote_attention";
    private static final int MAX_ACTIVE = 200;
    private static final int MAX_BODY = 1000;

    private final Context context;
    private final NotificationManager manager;
    private final LinkedHashMap<String, Integer> active = new LinkedHashMap<>();

    AttentionNotificationCenter(Context context) {
        this.context = context.getApplicationContext();
        this.manager = (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
        ensureChannel();
    }

    synchronized void show(AttentionRequest request) {
        if (manager == null || request == null || request.transition != AttentionRequest.Transition.ASKED) return;
        String key = request.notificationKey();
        if (active.containsKey(key)) return;
        int notificationID = notificationID(key);
        Notification notification = buildNotification(request, notificationID);
        if (notification == null) return;
        try {
            manager.notify(notificationID, notification);
        } catch (SecurityException ignored) {
            // The user revoked notification permission after the service started. The in-app
            // Attention Inbox remains authoritative.
            return;
        }
        active.put(key, notificationID);
        while (active.size() > MAX_ACTIVE) {
            Iterator<Map.Entry<String, Integer>> iterator = active.entrySet().iterator();
            if (!iterator.hasNext()) break;
            Map.Entry<String, Integer> eldest = iterator.next();
            iterator.remove();
            manager.cancel(eldest.getValue());
        }
    }

    synchronized void resolve(AttentionRequest request) {
        if (manager == null || request == null || request.transition != AttentionRequest.Transition.RESOLVED) return;
        if (request.requestID != null && !request.requestID.isEmpty()) {
            cancel(request.notificationKey());
            return;
        }
        String prefix = request.resolutionPrefix();
        Iterator<Map.Entry<String, Integer>> iterator = active.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Integer> entry = iterator.next();
            if (!entry.getKey().startsWith(prefix)) continue;
            iterator.remove();
            manager.cancel(entry.getValue());
        }
    }

    synchronized void cancelAll() {
        if (manager != null) {
            for (Integer notificationID : active.values()) manager.cancel(notificationID);
        }
        active.clear();
    }

    synchronized boolean hasActiveForSession(String machineID, String agentID, String sessionID) {
        if (machineID == null || agentID == null || sessionID == null) return false;
        String prefix = machineID + "\u0000" + agentID + "\u0000" + sessionID + "\u0000";
        for (String key : active.keySet()) {
            if (key.startsWith(prefix)) return true;
        }
        return false;
    }

    private void cancel(String key) {
        Integer notificationID = active.remove(key);
        if (notificationID != null && manager != null) manager.cancel(notificationID);
    }

    synchronized void cancelPermission(String machineID, String agentID, String sessionID, String requestID) {
        if (machineID == null || agentID == null || sessionID == null || requestID == null || requestID.isEmpty()) return;
        cancel(machineID + "\u0000" + agentID + "\u0000" + sessionID + "\u0000permission\u0000" + requestID);
    }

    private Notification buildNotification(AttentionRequest request, int notificationID) {
        String deepLink = AttentionDeepLink.forRequest(request.machineID, request.agentID, request.sessionID);
        if (deepLink == null) return null;
        Intent intent = new Intent(context, MainActivity.class)
            // Capacitor App only emits appUrlOpen for ACTION_VIEW. An explicit component still
            // launches MainActivity, so this also works for a cold start. Rebuild the task when the
            // previous WebView was destroyed in Doze instead of opening its blank page.
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(deepLink))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, notificationID, intent, pendingFlags);

        String title = context.getString(
            request.kind == AttentionRequest.Kind.PERMISSION
                ? R.string.hr_attention_permission_title
                : R.string.hr_attention_question_title
        );
        String body = body(request);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, ATTENTION_CHANNEL_ID)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(R.drawable.ic_stat_harness)
            .setContentTitle(title)
            .setContentText(body.replace('\n', ' '))
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setWhen(System.currentTimeMillis());
        if (request.kind == AttentionRequest.Kind.PERMISSION
            && request.requestID != null
            && !request.requestID.isEmpty()) {
            builder.addAction(permissionAction(
                request,
                notificationID,
                "once",
                R.string.hr_attention_allow_once,
                android.R.drawable.ic_menu_edit
            ));
            builder.addAction(permissionAction(
                request,
                notificationID,
                "reject",
                R.string.hr_attention_deny,
                android.R.drawable.ic_menu_close_clear_cancel
            ));
        }
        return builder.build();
    }

    private Notification.Action permissionAction(
        AttentionRequest request,
        int notificationID,
        String reply,
        int label,
        int icon
    ) {
        Intent action = new Intent(context, BackgroundAttentionService.class)
            .setAction(BackgroundAttentionService.ACTION_PERMISSION_REPLY)
            .setData(Uri.parse("harnessremote://permission-reply/" + notificationID + "/" + reply))
            .putExtra(BackgroundAttentionService.EXTRA_PERMISSION_MACHINE, request.machineID)
            .putExtra(BackgroundAttentionService.EXTRA_PERMISSION_AGENT, request.agentID)
            .putExtra(BackgroundAttentionService.EXTRA_PERMISSION_SESSION, request.sessionID)
            .putExtra(BackgroundAttentionService.EXTRA_PERMISSION_REQUEST, request.requestID)
            .putExtra(BackgroundAttentionService.EXTRA_PERMISSION_REPLY, reply);
        if (request.directory != null) {
            action.putExtra(BackgroundAttentionService.EXTRA_PERMISSION_DIRECTORY, request.directory);
        }
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getService(context, notificationID, action, pendingFlags);
        return new Notification.Action.Builder(
            Icon.createWithResource(context, icon),
            context.getString(label),
            pending
        ).build();
    }

    private String body(AttentionRequest request) {
        String identity = request.machineName + " · " + request.agentLabel;
        if (request.kind == AttentionRequest.Kind.PERMISSION) {
            return compactBody(
                request.action != null ? request.action : context.getString(R.string.hr_attention_permission_fallback),
                request.explanation,
                request.boundary != null ? context.getString(R.string.hr_attention_boundary, request.boundary) : null,
                context.getString(R.string.hr_attention_permission_consequence),
                identity
            );
        }
        return compactBody(
            request.question != null ? request.question : context.getString(R.string.hr_attention_question_fallback),
            context.getString(R.string.hr_attention_question_consequence),
            identity
        );
    }

    private static String compactBody(String... parts) {
        StringBuilder body = new StringBuilder();
        for (String part : parts) {
            if (part == null) continue;
            String value = part.trim();
            if (value.isEmpty()) continue;
            if (body.length() > 0) body.append('\n');
            body.append(value);
            if (body.length() >= MAX_BODY) break;
        }
        return body.length() > MAX_BODY ? body.substring(0, MAX_BODY) : body.toString();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) return;
        if (manager.getNotificationChannel(ATTENTION_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            ATTENTION_CHANNEL_ID,
            context.getString(R.string.hr_attention_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(context.getString(R.string.hr_attention_channel_description));
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    static int notificationID(String key) {
        int value = key.hashCode() & 0x7fffffff;
        return value == 0 ? 1 : value;
    }
}
