package ai.harness.remote;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Paired machines the background service may connect to. This is deliberately app-private: LAN
 * profiles carry Basic credentials; E1 profiles carry their pinned remote identity. Neither is
 * exposed through an exported component.
 */
final class BackgroundAttentionConfig {
    static final String PREFS_NAME = "harness_remote_background_attention";
    static final String KEY_MACHINES = "machines";
    static final String KEY_BATTERY_PROMPTED = "battery_prompted";
    static final String KEY_NOTIFICATION_PROMPTED = "notification_prompted";
    static final String KEY_NOTIFICATION_PROMPT_PENDING = "notification_prompt_pending";
    static final int MAX_MACHINES = 6;
    static final int MAX_AGENTS_PER_MACHINE = 12;

    private static final int MAX_ID = 256;
    private static final int MAX_NAME = 256;
    private static final int MAX_URL = 2048;
    private static final int MAX_USERNAME = 512;
    private static final int MAX_PASSWORD = 2048;

    static final class Machine {
        final String id;
        final String name;
        final String baseUrl;
        final String username;
        final String password;
        final String remoteMachineID;
        final String remoteDnsName;
        final String remotePin;

        Machine(String id, String name, String baseUrl, String username, String password,
            String remoteMachineID, String remoteDnsName, String remotePin) {
            this.id = id;
            this.name = name;
            this.baseUrl = baseUrl;
            this.username = username;
            this.password = password;
            this.remoteMachineID = remoteMachineID;
            this.remoteDnsName = remoteDnsName;
            this.remotePin = remotePin;
        }

        boolean isRemote() { return remoteMachineID != null; }

        boolean sameConnection(Machine other) {
            return other != null
                && id.equals(other.id)
                && name.equals(other.name)
                && baseUrl.equals(other.baseUrl)
                && username.equals(other.username)
                && password.equals(other.password)
                && equal(remoteMachineID, other.remoteMachineID)
                && equal(remoteDnsName, other.remoteDnsName)
                && equal(remotePin, other.remotePin);
        }

        JSONObject toJson() {
            try {
                JSONObject object = new JSONObject();
                object.put("id", id);
                object.put("name", name);
                object.put("baseUrl", baseUrl);
                object.put("username", username);
                object.put("password", password);
                if (isRemote()) {
                    object.put("remoteMachineID", remoteMachineID);
                    object.put("remoteDnsName", remoteDnsName);
                    object.put("remotePin", remotePin);
                }
                return object;
            } catch (JSONException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        static Machine fromJson(JSONObject object) {
            if (object == null) return null;
            String id = cleanText(object.optString("id", ""), MAX_ID);
            String name = cleanText(object.optString("name", ""), MAX_NAME);
            String baseUrl = cleanText(object.optString("baseUrl", ""), MAX_URL);
            String username = boundedString(object.optString("username", ""), MAX_USERNAME);
            String password = boundedString(object.optString("password", ""), MAX_PASSWORD);
            String remoteMachineID = optionalCleanText(object, "remoteMachineID", MAX_ID);
            String remoteDnsName = optionalCleanText(object, "remoteDnsName", 253);
            String remotePin = optionalCleanText(object, "remotePin", 64);
            if (id == null || name == null || baseUrl == null || username == null || password == null) return null;
            if (!validBaseUrl(baseUrl)) return null;
            boolean hasRemoteIdentity = object.has("remoteMachineID") || object.has("remoteDnsName") || object.has("remotePin");
            if (hasRemoteIdentity && !validRemoteIdentity(baseUrl, remoteMachineID, remoteDnsName, remotePin)) return null;
            if (username.length() + password.length() > MAX_USERNAME + MAX_PASSWORD) return null;
            return new Machine(id, name, baseUrl, username, password,
                hasRemoteIdentity ? remoteMachineID : null,
                hasRemoteIdentity ? remoteDnsName : null,
                hasRemoteIdentity ? remotePin : null);
        }

        private static String optionalCleanText(JSONObject object, String key, int maximum) {
            if (!object.has(key) || object.isNull(key)) return null;
            return cleanText(object.optString(key, null), maximum);
        }

        private static boolean equal(String left, String right) {
            return left == null ? right == null : left.equals(right);
        }
    }

    private BackgroundAttentionConfig() {}

    static List<Machine> parse(String raw) {
        if (raw == null || raw.trim().isEmpty()) return new ArrayList<>();
        try {
            JSONArray array = new JSONArray(raw);
            Map<String, Machine> byID = new LinkedHashMap<>();
            Map<String, Boolean> byEndpoint = new LinkedHashMap<>();
            for (int index = 0; index < array.length() && byID.size() < MAX_MACHINES; index++) {
                JSONObject object = array.optJSONObject(index);
                Machine machine = Machine.fromJson(object);
                if (machine == null || byID.containsKey(machine.id) || byEndpoint.containsKey(machine.baseUrl)) continue;
                byID.put(machine.id, machine);
                byEndpoint.put(machine.baseUrl, true);
            }
            return new ArrayList<>(byID.values());
        } catch (Exception ignored) {
            return null;
        }
    }

    static String serialize(List<Machine> machines) {
        JSONArray array = new JSONArray();
        for (Machine machine : machines) array.put(machine.toJson());
        return array.toString();
    }

    static List<Machine> load(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        List<Machine> parsed = parse(preferences.getString(KEY_MACHINES, "[]"));
        return parsed == null ? new ArrayList<>() : parsed;
    }

    static void save(Context context, List<Machine> machines) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MACHINES, serialize(machines))
            .apply();
    }

    static boolean batteryPrompted(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_BATTERY_PROMPTED, false);
    }

    static void setBatteryPrompted(Context context, boolean prompted) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_BATTERY_PROMPTED, prompted)
            .apply();
    }

    static final String KEY_NOTIFY_READY = "notify_ready";
    static final String KEY_NOTIFY_FAILED = "notify_failed";
    static final String KEY_NOTIFY_ATTENTION = "notify_attention";

    /**
     * Settings → Notifications on this device. Stored natively because the service posts while the
     * WebView is suspended or gone. Every kind defaults to on, matching the app's defaults.
     */
    static void setNotificationKinds(Context context, boolean ready, boolean failed, boolean attention) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NOTIFY_READY, ready)
            .putBoolean(KEY_NOTIFY_FAILED, failed)
            .putBoolean(KEY_NOTIFY_ATTENTION, attention)
            .apply();
    }

    static boolean notificationKindEnabled(Context context, String key) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(key, true);
    }

    static boolean notificationPrompted(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_NOTIFICATION_PROMPTED, false);
    }

    static void setNotificationPrompted(Context context, boolean prompted) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NOTIFICATION_PROMPTED, prompted)
            .apply();
    }

    static boolean notificationPromptPending(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_NOTIFICATION_PROMPT_PENDING, false);
    }

    static void setNotificationPromptPending(Context context, boolean pending) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NOTIFICATION_PROMPT_PENDING, pending)
            .apply();
    }

    private static String cleanText(String value, int maximum) {
        if (value == null) return null;
        String normalized = value.trim();
        if (normalized.isEmpty() || normalized.length() > maximum) return null;
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (character < 0x20 || character == 0x7f) return null;
        }
        return normalized;
    }

    private static String boundedString(String value, int maximum) {
        if (value == null || value.length() > maximum) return null;
        return value;
    }

    private static boolean validBaseUrl(String value) {
        try {
            URL url = new URL(value);
            String protocol = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.US);
            if (!"http".equals(protocol) && !"https".equals(protocol)) return false;
            if (url.getHost() == null || url.getHost().isEmpty()) return false;
            int port = url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
            if (port < 1 || port > 65_535) return false;
            if (url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) return false;
            String path = url.getPath();
            return path == null || path.isEmpty() || "/".equals(path);
        } catch (MalformedURLException ignored) {
            return false;
        }
    }

    static boolean validRemoteIdentity(String baseUrl, String machineID, String dnsName, String pin) {
        return baseUrl != null && baseUrl.regionMatches(true, 0, "https://", 0, 8)
            && machineID != null && machineID.matches("[A-Za-z0-9_-]{1,128}")
            && dnsName != null && dnsName.matches(
                "m-[a-f0-9]{32}\\.[a-f0-9]{32}\\.machine\\.harness-remote\\.invalid"
            )
            && pin != null && pin.matches("[a-f0-9]{64}");
    }
}
