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
 * Paired machines the background service may connect to. This is deliberately app-private: the
 * service needs the same Basic credentials the WebView already stores, but it never logs them and
 * it never exposes this configuration through an exported component.
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

        Machine(String id, String name, String baseUrl, String username, String password) {
            this.id = id;
            this.name = name;
            this.baseUrl = baseUrl;
            this.username = username;
            this.password = password;
        }

        boolean sameConnection(Machine other) {
            return other != null
                && id.equals(other.id)
                && name.equals(other.name)
                && baseUrl.equals(other.baseUrl)
                && username.equals(other.username)
                && password.equals(other.password);
        }

        JSONObject toJson() {
            try {
                JSONObject object = new JSONObject();
                object.put("id", id);
                object.put("name", name);
                object.put("baseUrl", baseUrl);
                object.put("username", username);
                object.put("password", password);
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
            if (id == null || name == null || baseUrl == null || username == null || password == null) return null;
            if (!validBaseUrl(baseUrl)) return null;
            if (username.length() + password.length() > MAX_USERNAME + MAX_PASSWORD) return null;
            return new Machine(id, name, baseUrl, username, password);
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
}
