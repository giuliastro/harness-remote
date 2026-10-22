package ai.harness.remote;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Opt-in foreground service that polls each configured machine/agent for session status and
 * posts a notification when a session finishes or needs attention. No Firebase involved.
 */
public class SessionMonitorService extends Service {
    private static final String SERVICE_CHANNEL_ID = "hr_monitor_service";
    private static final String UPDATES_CHANNEL_ID = "hr_session_updates";
    private static final int SERVICE_NOTIFICATION_ID = 7301;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int READ_TIMEOUT_MS = 15000;
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024;
    private static final int MAX_TRACKED_SESSIONS = 5000;
    private static final int MAX_TITLE_PAGES = 5;
    private static final int MAX_ROW_CHARS = 16_384;

    private enum State { WORKING, ATTENTION, IDLE }

    private static final class TargetState {
        final Map<String, State> previous = new HashMap<>();
        boolean baselined = false;
    }

    private static final class Target {
        String machineID, agentID, agentLabel, machineName, statusUrl, sessionsUrl, authorization, backend;

        String key() {
            return machineID + "\u0000" + agentID + "\u0000" + statusUrl;
        }
    }

    private static volatile boolean running = false;
    private static volatile boolean appVisible = false;
    private static volatile String focusedMachine = "";
    private static volatile String focusedAgent = "";
    private static volatile String focusedSession = "";

    static boolean isRunning() {
        return running;
    }

    static void setAppVisible(boolean visible) {
        appVisible = visible;
    }

    static void setFocused(String machineID, String agentID, String sessionID) {
        focusedMachine = machineID;
        focusedAgent = agentID;
        focusedSession = sessionID;
    }

    private final Object lock = new Object();
    private ScheduledExecutorService executor;
    private ScheduledFuture<?> schedule;
    private PowerManager.WakeLock wakeLock;
    private List<Target> targets = new ArrayList<>();
    private volatile JSONObject texts = new JSONObject();
    private volatile List<String> hideNeedles = new ArrayList<>();
    private final Map<String, TargetState> states = new HashMap<>();

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        JSONObject config = readConfig();
        boolean enabled = config != null && config.optBoolean("enabled", false);
        JSONArray rawTargets = config == null ? null : config.optJSONArray("targets");
        if (!enabled || rawTargets == null || rawTargets.length() == 0) {
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }

        List<Target> parsed = parseTargets(rawTargets);
        JSONObject newTexts = config.optJSONObject("texts");
        texts = newTexts == null ? new JSONObject() : newTexts;
        hideNeedles = parseNeedles(config.optJSONArray("hideNeedles"));
        int interval = Math.max(10, Math.min(900, config.optInt("intervalSeconds", 30)));
        boolean keepAwake = config.optBoolean("keepAwake", false);

        createChannels();
        try {
            ServiceCompat.startForeground(
                this,
                SERVICE_NOTIFICATION_ID,
                buildServiceNotification(parsed.size()),
                Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0
            );
        } catch (Exception error) {
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }

        synchronized (lock) {
            // Keep per-session state only for targets whose key is unchanged.
            Set<String> keep = new HashSet<>();
            for (Target t : parsed) keep.add(t.key());
            states.keySet().retainAll(keep);
            targets = parsed;
            if (schedule != null) schedule.cancel(true);
            if (executor == null) executor = Executors.newSingleThreadScheduledExecutor();
            schedule = executor.scheduleWithFixedDelay(this::pollAll, 0, interval, TimeUnit.SECONDS);
            updateWakeLock(keepAwake);
        }
        running = true;
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        synchronized (lock) {
            if (executor != null) executor.shutdownNow();
            executor = null;
            schedule = null;
            updateWakeLock(false);
        }
        running = false;
        super.onDestroy();
    }

    private void updateWakeLock(boolean keepAwake) {
        if (keepAwake) {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HarnessRemote:SessionMonitor");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire();
        } else if (wakeLock != null) {
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock = null;
        }
    }

    private JSONObject readConfig() {
        try {
            SharedPreferences prefs = getSharedPreferences(SessionMonitorPlugin.PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(SessionMonitorPlugin.PREFS_KEY_CONFIG, null);
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception error) {
            return null;
        }
    }

    private List<Target> parseTargets(JSONArray raw) {
        List<Target> list = new ArrayList<>();
        for (int i = 0; i < raw.length(); i++) {
            JSONObject o = raw.optJSONObject(i);
            if (o == null) continue;
            Target t = new Target();
            t.machineID = o.optString("machineID", "");
            t.agentID = o.optString("agentID", "");
            t.agentLabel = o.optString("agentLabel", "");
            t.machineName = o.optString("machineName", "");
            t.statusUrl = o.optString("statusUrl", "");
            t.sessionsUrl = o.optString("sessionsUrl", "");
            t.authorization = o.optString("authorization", "");
            t.backend = o.optString("backend", "");
            list.add(t);
        }
        return list;
    }

    private String text(String key) {
        return texts.optString(key, "");
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel service = new NotificationChannel(
            SERVICE_CHANNEL_ID, nonEmpty(text("serviceChannelName"), "Session monitor"), NotificationManager.IMPORTANCE_MIN);
        service.setShowBadge(false);
        nm.createNotificationChannel(service);
        NotificationChannel updates = new NotificationChannel(
            UPDATES_CHANNEL_ID, nonEmpty(text("channelName"), "Session updates"), NotificationManager.IMPORTANCE_DEFAULT);
        String description = text("channelDescription");
        if (!description.isEmpty()) updates.setDescription(description);
        nm.createNotificationChannel(updates);
    }

    private Notification buildServiceNotification(int count) {
        String body = text("serviceText").replace("{count}", String.valueOf(count));
        return new NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_harness)
            .setContentTitle(nonEmpty(text("serviceTitle"), "Harness Remote"))
            .setContentText(body)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(PendingIntent.getActivity(
                this, SERVICE_NOTIFICATION_ID, new Intent(this, MainActivity.class)
                    .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .build();
    }

    private static String nonEmpty(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private void pollAll() {
        List<Target> snapshot;
        synchronized (lock) {
            snapshot = new ArrayList<>(targets);
        }
        for (Target target : snapshot) {
            if (Thread.currentThread().isInterrupted()) return;
            try {
                pollTarget(target);
            } catch (Exception ignored) {
                // One unreachable machine must never stop the others; keep previous state.
            }
        }
    }

    private static final class Event {
        final String sessionID;
        final boolean attention;

        Event(String sessionID, boolean attention) {
            this.sessionID = sessionID;
            this.attention = attention;
        }
    }

    private void pollTarget(Target target) throws Exception {
        String body = httpGet(target.statusUrl, target);
        if (body == null) return;
        JSONObject response = new JSONObject(body);

        Map<String, State> current = new HashMap<>();
        Iterator<String> ids = response.keys();
        while (ids.hasNext() && current.size() < MAX_TRACKED_SESSIONS) {
            String id = ids.next();
            JSONObject entry = response.optJSONObject(id);
            current.put(id, entry == null ? State.IDLE : classify(entry.optString("type", "")));
        }

        List<Event> events = new ArrayList<>();
        synchronized (lock) {
            TargetState state = states.get(target.key());
            if (state == null) {
                state = new TargetState();
                states.put(target.key(), state);
            }
            if (state.baselined) {
                for (Map.Entry<String, State> e : current.entrySet()) {
                    State before = state.previous.get(e.getKey());
                    if (before == null) continue;
                    if (before == State.WORKING && e.getValue() == State.IDLE) {
                        events.add(new Event(e.getKey(), false));
                    } else if (before != State.ATTENTION && e.getValue() == State.ATTENTION) {
                        events.add(new Event(e.getKey(), true));
                    }
                }
            }
            state.previous.clear();
            state.previous.putAll(current);
            state.baselined = true;
        }
        if (events.isEmpty()) return;

        Set<String> wanted = new HashSet<>();
        for (Event event : events) wanted.add(event.sessionID);
        Map<String, String> rows = new HashMap<>();
        Map<String, String> titles = fetchTitles(target, wanted, rows);
        for (Event event : events) {
            // Sessions the home hides by title (automatic reviews, one-shot prompts) stay silent too.
            if (hiddenByRules(titles.get(event.sessionID))) continue;
            if (appVisible
                && target.machineID.equals(focusedMachine)
                && target.agentID.equals(focusedAgent)
                && event.sessionID.equals(focusedSession)) continue;
            notifyEvent(target, event, titles.get(event.sessionID), rows.get(event.sessionID));
        }
    }

    private static List<String> parseNeedles(JSONArray raw) {
        List<String> needles = new ArrayList<>();
        if (raw == null) return needles;
        for (int i = 0; i < raw.length(); i++) {
            String needle = normalizeForMatch(raw.optString(i, ""));
            if (!needle.isEmpty()) needles.add(needle);
        }
        return needles;
    }

    /** Mirrors normalizeForMatch() in appPreferences.ts: no accents, lower case, single spaces. */
    private static String normalizeForMatch(String value) {
        if (value == null) return "";
        String plain = Normalizer.normalize(value, Normalizer.Form.NFD).replaceAll("[\\u0300-\\u036f]", "");
        return plain.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim();
    }

    private boolean hiddenByRules(String title) {
        List<String> needles = hideNeedles;
        if (title == null || title.isEmpty() || needles.isEmpty()) return false;
        String normalized = normalizeForMatch(title);
        for (String needle : needles) {
            if (normalized.contains(needle)) return true;
        }
        return false;
    }

    private static State classify(String type) {
        String t = type.trim().toLowerCase();
        switch (t) {
            case "busy":
            case "running":
            case "working":
            case "waiting":
            case "retry":
            case "in_progress":
            case "in-progress":
                return State.WORKING;
            default:
                break;
        }
        if (t.contains("error") || t.contains("fail") || t.contains("attention")) return State.ATTENTION;
        return State.IDLE;
    }

    /**
     * Titles of the Sessions that just changed. The listing is paged (x-next-cursor); a finished
     * Session is usually on the first page, but follow up to MAX_TITLE_PAGES so hide rules still
     * apply to an older Session that came back to life.
     */
    private Map<String, String> fetchTitles(Target target, Set<String> wanted, Map<String, String> rows) {
        Map<String, String> titles = new HashMap<>();
        String cursor = null;
        Set<String> seenCursors = new HashSet<>();
        try {
            for (int page = 0; page < MAX_TITLE_PAGES; page++) {
                String url = cursor == null ? target.sessionsUrl
                    : target.sessionsUrl + (target.sessionsUrl.contains("?") ? "&" : "?") + "cursor=" + URLEncoder.encode(cursor, "UTF-8");
                String[] nextCursor = new String[1];
                String body = httpGet(url, target, nextCursor);
                if (body == null) break;
                JSONArray array = new JSONArray(body);
                for (int i = 0; i < array.length(); i++) {
                    JSONObject o = array.optJSONObject(i);
                    if (o == null) continue;
                    String id = o.optString("id", "");
                    String title = o.optString("title", "");
                    if (!wanted.contains(id)) continue;
                    if (!title.isEmpty()) titles.put(id, title);
                    String row = o.toString();
                    if (row.length() <= MAX_ROW_CHARS) rows.put(id, row);
                }
                if (titles.keySet().containsAll(wanted)) break;
                cursor = nextCursor[0];
                if (cursor == null || cursor.isEmpty() || !seenCursors.add(cursor)) break;
            }
        } catch (Exception ignored) {
            // Titles are cosmetic; fall back to the untitled text.
        }
        return titles;
    }

    private void notifyEvent(Target target, Event event, String title, String row) {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        // The full key is the notification tag, so two sessions never replace each other's notification.
        String notificationTag = target.machineID + "\u0000" + target.agentID + "\u0000" + event.sessionID;
        int notificationId = notificationTag.hashCode();
        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(SessionMonitorPlugin.EXTRA_MACHINE, target.machineID)
            .putExtra(SessionMonitorPlugin.EXTRA_AGENT, target.agentID)
            .putExtra(SessionMonitorPlugin.EXTRA_SESSION, event.sessionID)
            .putExtra(SessionMonitorPlugin.EXTRA_TOKEN, SessionMonitorPlugin.tapToken(this));
        // The listing row lets the app open the Session at once instead of paging the history.
        if (row != null) open.putExtra(SessionMonitorPlugin.EXTRA_ROW, row);
        // Extras do not make PendingIntents distinct; the identifier does, so colliding hash codes
        // still open their own Session.
        if (Build.VERSION.SDK_INT >= 29) open.setIdentifier(notificationTag);
        PendingIntent pending = PendingIntent.getActivity(
            this, notificationId, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String heading = text(event.attention ? "attention" : "finished").replace("{agent}", target.agentLabel);
        String content = title == null || title.isEmpty() ? text("untitled") : title;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, UPDATES_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_harness)
            .setContentTitle(heading)
            .setContentText(content)
            .setSubText(target.machineName)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            // A Session title can be the user's prompt: keep it off the lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(new NotificationCompat.Builder(this, UPDATES_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_harness)
                .setContentTitle(heading)
                .build())
            .setContentIntent(pending);
        try {
            NotificationManagerCompat.from(this).notify(notificationTag, 1, builder.build());
        } catch (SecurityException ignored) {
            // Permission revoked between the check and the post; skip silently.
        }
    }

    private String httpGet(String endpoint, Target target) throws Exception {
        return httpGet(endpoint, target, null);
    }

    /**
     * Returns the response body, or null for a non-200 status; nextCursor[0] receives the
     * x-next-cursor header when asked. Never logs the URL or credentials.
     */
    private String httpGet(String endpoint, Target target, String[] nextCursor) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            if (!target.authorization.isEmpty()) connection.setRequestProperty("Authorization", target.authorization);
            if (!target.backend.isEmpty()) connection.setRequestProperty("X-Harness-Backend", target.backend);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            if (nextCursor != null) nextCursor[0] = connection.getHeaderField("x-next-cursor");
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int total = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_BODY_BYTES) return null;
                    out.write(buffer, 0, read);
                }
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
