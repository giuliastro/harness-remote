package ai.harness.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import java.util.Iterator;
import java.util.LinkedHashMap;

/**
 * Ready/Failed notifications for background native Sessions. It only observes normalized lifecycle
 * edges: a turn must have been seen working before idle becomes Ready, a pending permission/question
 * suppresses Ready, and a new working edge retires the previous outcome.
 */
final class SessionOutcomeCenter {
    static final String CHANNEL_ID = "harness_remote_session_outcomes";
    private static final int MAX_SESSIONS = 64;
    private static final int MAX_BODY = 1000;

    private final Context context;
    private final NotificationManager manager;
    private final AttentionNotificationCenter attention;
    private final LinkedHashMap<String, SessionState> sessions = new LinkedHashMap<>();

    SessionOutcomeCenter(Context context, AttentionNotificationCenter attention) {
        this.context = context.getApplicationContext();
        this.manager = (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
        this.attention = attention;
        ensureChannel();
    }

    synchronized void onEvent(SessionOutcomeEvent event) {
        if (manager == null || event == null) return;
        String key = event.sessionKey();
        SessionState state = sessions.get(key);
        if (state == null) {
            if (sessions.size() >= MAX_SESSIONS) {
                Iterator<SessionState> iterator = sessions.values().iterator();
                if (iterator.hasNext()) {
                    SessionState oldest = iterator.next();
                    iterator.remove();
                    cancel(oldest);
                }
            }
            state = new SessionState();
            sessions.put(key, state);
        }

        switch (event.kind) {
            case WORKING:
                state.working = true;
                state.lastOutcome = null;
                cancel(state);
                break;
            case IDLE:
                if (!state.working) return;
                state.working = false;
                if (BackgroundAttentionVisibility.isVisible(event.machineID, event.agentID, event.sessionID)) {
                    state.lastOutcome = "READY";
                    cancel(state);
                    return;
                }
                if (attention != null && attention.hasActiveForSession(event.machineID, event.agentID, event.sessionID)) {
                    return;
                }
                if ("READY".equals(state.lastOutcome)) return;
                cancel(state);
                post(event, "READY");
                break;
            case FAILED:
                state.working = false;
                if (BackgroundAttentionVisibility.isVisible(event.machineID, event.agentID, event.sessionID)) {
                    state.lastOutcome = "FAILED";
                    cancel(state);
                    return;
                }
                if ("FAILED".equals(state.lastOutcome)) return;
                cancel(state);
                post(event, "FAILED");
                break;
        }
    }

    synchronized void cancelAll() {
        for (SessionState state : sessions.values()) cancel(state);
        sessions.clear();
    }

    synchronized void onVisibilityChanged(String machineID, String agentID, String sessionID) {
        if (machineID == null || agentID == null || sessionID == null) return;
        SessionState state = sessions.get(machineID + "\u0000" + agentID + "\u0000" + sessionID);
        if (state != null) cancel(state);
    }

    private void post(SessionOutcomeEvent event, String outcome) {
        String deepLink = AttentionDeepLink.forRequest(event.machineID, event.agentID, event.sessionID);
        if (deepLink == null) return;
        String key = event.sessionKey();
        int notificationID = notificationID(key);
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(deepLink))
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, notificationID, intent, pendingFlags);

        boolean ready = "READY".equals(outcome);
        String title = context.getString(ready ? R.string.hr_outcome_ready_title : R.string.hr_outcome_failed_title);
        String body = compactBody(
            ready
                ? context.getString(R.string.hr_outcome_ready_body)
                : event.errorMessage != null ? event.errorMessage : context.getString(R.string.hr_outcome_failed_body),
            event.machineName + " · " + event.agentLabel + " · " + shortSession(event.sessionID)
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
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
        try {
            manager.notify(notificationID, builder.build());
        } catch (SecurityException ignored) {
            return;
        }
        SessionState state = sessions.get(key);
        if (state != null) {
            state.notificationID = notificationID;
            state.lastOutcome = outcome;
        }
    }

    private void cancel(SessionState state) {
        if (state == null || state.notificationID == 0 || manager == null) return;
        manager.cancel(state.notificationID);
        state.notificationID = 0;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.hr_outcome_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(context.getString(R.string.hr_outcome_channel_description));
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
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

    private static String shortSession(String sessionID) {
        if (sessionID.length() <= 18) return sessionID;
        return sessionID.substring(0, 10) + "…" + sessionID.substring(sessionID.length() - 5);
    }

    private static int notificationID(String key) {
        int value = key.hashCode() & 0x7fffffff;
        return value == 0 ? 1 : value;
    }

    private static final class SessionState {
        boolean working;
        String lastOutcome;
        int notificationID;
    }
}
