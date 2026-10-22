package ai.harness.remote;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "SessionMonitor",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
)
public class SessionMonitorPlugin extends Plugin {
    static final String PREFS_NAME = "harness_session_monitor";
    static final String PREFS_KEY_CONFIG = "config";
    static final String ACTION_CONFIGURE = "ai.harness.remote.monitor.CONFIGURE";
    static final String EXTRA_MACHINE = "hr_monitor_machine";
    static final String EXTRA_AGENT = "hr_monitor_agent";
    static final String EXTRA_SESSION = "hr_monitor_session";
    static final String EXTRA_TOKEN = "hr_monitor_token";
    static final String EXTRA_ROW = "hr_monitor_row";
    private static final String PREFS_KEY_TAP_TOKEN = "tapToken";

    private static final int MAX_TARGETS = 32;
    private static final int MAX_HIDE_NEEDLES = 200;
    private static final int MAX_FIELD_LENGTH = 2048;
    private static final int MIN_INTERVAL_SECONDS = 10;
    private static final int MAX_INTERVAL_SECONDS = 900;
    private static final int DEFAULT_INTERVAL_SECONDS = 30;
    private static final String[] TEXT_KEYS = {
        "channelName", "channelDescription", "serviceChannelName", "serviceTitle", "serviceText",
        "finished", "attention", "untitled"
    };
    private static final String[] TARGET_KEYS = {
        "machineID", "agentID", "agentLabel", "machineName", "statusUrl", "sessionsUrl", "authorization", "backend"
    };

    @Override
    public void load() {
        if (getActivity() != null) deliverTap(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        deliverTap(intent);
    }

    @Override
    protected void handleOnResume() {
        SessionMonitorService.setAppVisible(true);
    }

    @Override
    protected void handleOnPause() {
        SessionMonitorService.setAppVisible(false);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        try {
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            int interval = clampInterval(call.getInt("intervalSeconds", DEFAULT_INTERVAL_SECONDS));
            boolean keepAwake = Boolean.TRUE.equals(call.getBoolean("keepAwake", false));

            JSONObject texts = new JSONObject();
            JSObject inTexts = call.getObject("texts");
            for (String key : TEXT_KEYS) {
                texts.put(key, inTexts == null ? "" : limited(inTexts.optString(key, "")));
            }

            JSONArray targets = new JSONArray();
            JSONArray inTargets = call.getArray("targets");
            if (inTargets != null) {
                for (int i = 0; i < inTargets.length() && targets.length() < MAX_TARGETS; i++) {
                    JSONObject in = inTargets.optJSONObject(i);
                    if (in == null) continue;
                    JSONObject out = new JSONObject();
                    for (String key : TARGET_KEYS) out.put(key, limited(in.optString(key, "")));
                    if (!httpUrl(out.getString("statusUrl")) || !httpUrl(out.getString("sessionsUrl"))) continue;
                    targets.put(out);
                }
            }

            // Credentials are persisted only while the monitor is on; switching it off wipes them.
            if (!enabled) targets = new JSONArray();

            JSONArray hideNeedles = new JSONArray();
            JSONArray inNeedles = call.getArray("hideNeedles");
            if (enabled && inNeedles != null) {
                for (int i = 0; i < inNeedles.length() && hideNeedles.length() < MAX_HIDE_NEEDLES; i++) {
                    String needle = limited(inNeedles.optString(i, "")).trim();
                    if (!needle.isEmpty()) hideNeedles.put(needle);
                }
            }

            JSONObject config = new JSONObject();
            config.put("enabled", enabled);
            config.put("hideNeedles", hideNeedles);
            config.put("intervalSeconds", interval);
            config.put("keepAwake", keepAwake);
            config.put("texts", texts);
            config.put("targets", targets);

            Context ctx = getContext();
            // App-private storage: same trust level as the WebView localStorage that already holds these credentials.
            ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putString(PREFS_KEY_CONFIG, config.toString()).apply();

            Intent intent = new Intent(ctx, SessionMonitorService.class);
            boolean running;
            if (enabled && targets.length() > 0) {
                intent.setAction(ACTION_CONFIGURE);
                ContextCompat.startForegroundService(ctx, intent);
                running = true;
            } else {
                ctx.stopService(intent);
                running = false;
            }
            JSObject result = new JSObject();
            result.put("running", running);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not configure session monitor");
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        JSObject result = new JSObject();
        result.put("running", SessionMonitorService.isRunning());
        result.put("ignoringBatteryOptimizations", ignoringBatteryOptimizations(ctx));
        result.put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context ctx = getContext();
        JSObject result = new JSObject();
        if (ignoringBatteryOptimizations(ctx)) {
            result.put("ignoringBatteryOptimizations", true);
            call.resolve(result);
            return;
        }
        Uri packageUri = Uri.parse("package:" + ctx.getPackageName());
        try {
            startSettings(ctx, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri));
        } catch (ActivityNotFoundException missing) {
            try {
                startSettings(ctx, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (ActivityNotFoundException ignored) {
                // No settings screen available on this device; report the unchanged state.
            }
        }
        result.put("ignoringBatteryOptimizations", false);
        call.resolve(result);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Context ctx = getContext();
        try {
            startSettings(ctx, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName())));
        } catch (ActivityNotFoundException ignored) {
            call.reject("Settings screen unavailable");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void setFocusedSession(PluginCall call) {
        SessionMonitorService.setFocused(
            limited(call.getString("machineID", "")),
            limited(call.getString("agentID", "")),
            limited(call.getString("sessionID", ""))
        );
        call.resolve();
    }

    /**
     * MainActivity is exported (it is the launcher), so any app could send it these extras. Only
     * taps carrying this install's random token, which lives in app-private storage and is put in
     * our own notifications' PendingIntents, may navigate to a Session.
     */
    static synchronized String tapToken(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String token = prefs.getString(PREFS_KEY_TAP_TOKEN, null);
        if (token == null || token.isEmpty()) {
            token = java.util.UUID.randomUUID().toString();
            prefs.edit().putString(PREFS_KEY_TAP_TOKEN, token).apply();
        }
        return token;
    }

    private void deliverTap(Intent intent) {
        if (intent == null) return;
        String session = intent.getStringExtra(EXTRA_SESSION);
        if (session == null || session.isEmpty()) return;
        String token = intent.getStringExtra(EXTRA_TOKEN);
        intent.removeExtra(EXTRA_TOKEN);
        if (token == null || !token.equals(tapToken(getContext()))) {
            intent.removeExtra(EXTRA_MACHINE);
            intent.removeExtra(EXTRA_AGENT);
            intent.removeExtra(EXTRA_SESSION);
            intent.removeExtra(EXTRA_ROW);
            return;
        }
        JSObject payload = new JSObject();
        payload.put("machineID", intent.getStringExtra(EXTRA_MACHINE));
        payload.put("agentID", intent.getStringExtra(EXTRA_AGENT));
        payload.put("sessionID", session);
        String row = intent.getStringExtra(EXTRA_ROW);
        if (row != null) payload.put("session", row);
        intent.removeExtra(EXTRA_ROW);
        intent.removeExtra(EXTRA_MACHINE);
        intent.removeExtra(EXTRA_AGENT);
        intent.removeExtra(EXTRA_SESSION);
        notifyListeners("notificationTap", payload, true);
    }

    private static void startSettings(Context ctx, Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
    }

    private static boolean ignoringBatteryOptimizations(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    private static int clampInterval(Integer value) {
        int v = value == null ? DEFAULT_INTERVAL_SECONDS : value;
        return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, v));
    }

    private static String limited(String value) {
        if (value == null) return "";
        return value.length() > MAX_FIELD_LENGTH ? value.substring(0, MAX_FIELD_LENGTH) : value;
    }

    private static boolean httpUrl(String value) {
        return value.startsWith("http://") || value.startsWith("https://");
    }
}
