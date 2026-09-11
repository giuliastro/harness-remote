package ai.harness.remote;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "LiveEvents")
public class LiveEventsPlugin extends Plugin {
    private static final int CONNECT_TIMEOUT_MS = 10000;
    // The daemon writes an SSE heartbeat every 10 seconds. A 30 second period with no bytes means
    // the socket is stale after sleep, backgrounding, Wi-Fi handoff or a brief network loss.
    private static final int STALL_TIMEOUT_MS = 30000;
    private static final int MAX_SUBSCRIPTION_ID_LENGTH = 240;
    private static final int MAX_ATTENTION_ID_LENGTH = 512;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7401;
    private static final String ATTENTION_CHANNEL_ID = "harness_remote_attention";
    private static final AtomicBoolean notificationPermissionRequested = new AtomicBoolean(false);

    private static final class AttentionContext {
        final String machineID;
        final String machineName;
        final String agentID;
        final String agentLabel;
        final boolean questions;
        final boolean permissions;

        AttentionContext(
            String machineID,
            String machineName,
            String agentID,
            String agentLabel,
            boolean questions,
            boolean permissions
        ) {
            this.machineID = machineID;
            this.machineName = machineName;
            this.agentID = agentID;
            this.agentLabel = agentLabel;
            this.questions = questions;
            this.permissions = permissions;
        }
    }

    /**
     * One Android plugin instance serves the whole WebView. Session detail, the global Attention
     * Inbox and multiple machines may all subscribe concurrently, so stream ownership must be keyed
     * instead of letting the most recent start() cancel every earlier socket.
     */
    private static final class StreamHandle {
        final AtomicBoolean stopped = new AtomicBoolean(false);
        final Set<String> seenAttentionRequests = ConcurrentHashMap.newKeySet();
        final AttentionContext attention;
        volatile Future<?> task;
        volatile HttpURLConnection connection;

        StreamHandle(AttentionContext attention) {
            this.attention = attention;
        }
    }

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, StreamHandle> streams = new ConcurrentHashMap<>();

    @PluginMethod
    public void start(PluginCall call) {
        String subscriptionID = call.getString("subscriptionID");
        String url = call.getString("url");
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        String backend = call.getString("backend", "");
        if (!validSubscriptionID(subscriptionID)) {
            call.reject("Missing or invalid subscription ID");
            return;
        }
        if (url == null || url.isEmpty()) {
            call.reject("Missing event stream URL");
            return;
        }

        AttentionContext attention = parseAttentionContext(url);
        if (attention != null) {
            ensureAttentionChannel();
            requestNotificationPermissionIfNeeded();
        }

        // Replacing the same logical subscription is safe and does not disturb any sibling stream.
        stopStream(subscriptionID, false);
        StreamHandle handle = new StreamHandle(attention);
        streams.put(subscriptionID, handle);
        String endpoint = stripFragment(url);
        handle.task = executor.submit(() -> runStream(subscriptionID, handle, endpoint, username, password, backend));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        String subscriptionID = call.getString("subscriptionID");
        if (!validSubscriptionID(subscriptionID)) {
            call.reject("Missing or invalid subscription ID");
            return;
        }
        stopStream(subscriptionID, true);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (String subscriptionID : streams.keySet()) stopStream(subscriptionID, false);
        streams.clear();
        executor.shutdownNow();
    }

    private boolean validSubscriptionID(String value) {
        return value != null && !value.isEmpty() && value.length() <= MAX_SUBSCRIPTION_ID_LENGTH;
    }

    private String cleanAttentionValue(String value) {
        if (value == null) return null;
        String normalized = value.trim();
        if (normalized.isEmpty() || normalized.length() > MAX_ATTENTION_ID_LENGTH) return null;
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (character < 0x20 || character == 0x7f) return null;
        }
        return normalized;
    }

    private AttentionContext parseAttentionContext(String endpoint) {
        try {
            String fragment = new URL(endpoint).getRef();
            if (fragment == null || fragment.isEmpty()) return null;
            Uri metadata = Uri.parse("https://harness.remote/?" + fragment);
            if (!"1".equals(metadata.getQueryParameter("hrAttention"))) return null;
            String machineID = cleanAttentionValue(metadata.getQueryParameter("machineID"));
            String machineName = cleanAttentionValue(metadata.getQueryParameter("machineName"));
            String agentID = cleanAttentionValue(metadata.getQueryParameter("agentID"));
            String agentLabel = cleanAttentionValue(metadata.getQueryParameter("agentLabel"));
            boolean questions = "1".equals(metadata.getQueryParameter("questions"));
            boolean permissions = "1".equals(metadata.getQueryParameter("permissions"));
            if (machineID == null || machineName == null || agentID == null || agentLabel == null || (!questions && !permissions)) {
                return null;
            }
            return new AttentionContext(machineID, machineName, agentID, agentLabel, questions, permissions);
        } catch (Exception ignored) {
            return null;
        }
    }

    private String stripFragment(String endpoint) {
        int index = endpoint.indexOf('#');
        return index >= 0 ? endpoint.substring(0, index) : endpoint;
    }

    private void stopStream(String subscriptionID, boolean publishClosed) {
        StreamHandle handle = streams.remove(subscriptionID);
        if (handle == null) return;
        handle.stopped.set(true);
        HttpURLConnection activeConnection = handle.connection;
        if (activeConnection != null) activeConnection.disconnect();
        Future<?> activeTask = handle.task;
        if (activeTask != null) activeTask.cancel(true);
        handle.connection = null;
        handle.task = null;
        if (publishClosed) publishStatus(subscriptionID, "closed", null, null);
    }

    private void runStream(
        String subscriptionID,
        StreamHandle handle,
        String endpoint,
        String username,
        String password,
        String backend
    ) {
        int delayMs = 1000;
        while (!handle.stopped.get() && streams.get(subscriptionID) == handle) {
            HttpURLConnection current = null;
            try {
                current = (HttpURLConnection) new URL(endpoint).openConnection();
                handle.connection = current;
                current.setRequestMethod("GET");
                current.setRequestProperty("Accept", "text/event-stream");
                if (backend != null && !backend.isEmpty()) current.setRequestProperty("X-Harness-Backend", backend);
                if (!username.isEmpty() || !password.isEmpty()) {
                    String credentials = username + ":" + password;
                    String encoded = Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                    current.setRequestProperty("Authorization", "Basic " + encoded);
                }
                current.setConnectTimeout(CONNECT_TIMEOUT_MS);
                current.setReadTimeout(STALL_TIMEOUT_MS);
                int status = current.getResponseCode();
                String contentType = current.getContentType();
                if (status != HttpURLConnection.HTTP_OK || contentType == null || !contentType.toLowerCase().contains("text/event-stream")) {
                    throw new IllegalStateException("HTTP " + status + "; expected text/event-stream");
                }
                delayMs = 1000;
                publishStatus(subscriptionID, "connected", null, null);
                readFrames(subscriptionID, handle, current.getInputStream());
            } catch (Exception error) {
                if (handle.stopped.get() || streams.get(subscriptionID) != handle) break;
                publishStatus(subscriptionID, "connection-error", error.getMessage(), null);
            } finally {
                if (current != null) current.disconnect();
                if (handle.connection == current) handle.connection = null;
            }
            if (!handle.stopped.get() && streams.get(subscriptionID) == handle) {
                publishStatus(subscriptionID, "reconnecting", null, delayMs);
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    break;
                }
                delayMs = Math.min(delayMs * 2, 30000);
            }
        }
    }

    private void readFrames(String subscriptionID, StreamHandle handle, InputStream inputStream) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            StringBuilder data = new StringBuilder();
            String line;
            while (!handle.stopped.get() && streams.get(subscriptionID) == handle && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        String frame = data.toString();
                        maybeNotifyAttention(handle, frame);
                        publishEvent(subscriptionID, frame);
                        data.setLength(0);
                    }
                    continue;
                }
                if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    String value = line.substring(5);
                    data.append(value.startsWith(" ") ? value.substring(1) : value);
                }
            }
        }
    }

    private JSONObject eventPayload(String data) {
        try {
            JSONObject envelope = new JSONObject(data);
            JSONObject payload = envelope.optJSONObject("payload");
            return payload != null ? payload : envelope;
        } catch (Exception ignored) {
            return null;
        }
    }

    private String firstText(JSONObject object, String... names) {
        if (object == null) return null;
        for (String name : names) {
            String value = object.optString(name, "").trim();
            if (!value.isEmpty()) return value;
        }
        return null;
    }

    private String requestKey(String family, JSONObject properties, String raw) {
        String requestID = firstText(properties, "id", "requestID", "permissionID");
        return family + ":" + (requestID != null ? requestID : Integer.toHexString(raw.hashCode()));
    }

    private void maybeNotifyAttention(StreamHandle handle, String raw) {
        AttentionContext context = handle.attention;
        if (context == null) return;
        JSONObject payload = eventPayload(raw);
        if (payload == null) return;
        String type = payload.optString("type", "");
        JSONObject properties = payload.optJSONObject("properties");
        if (properties == null) return;

        boolean questionAsked = context.questions && ("question.asked".equals(type) || "question.v2.asked".equals(type));
        boolean permissionAsked = context.permissions && ("permission.asked".equals(type) || "permission.v2.asked".equals(type));
        if (!questionAsked && !permissionAsked) {
            if (type.startsWith("question.") && (type.endsWith(".replied") || type.endsWith(".rejected"))) {
                handle.seenAttentionRequests.remove(requestKey("question", properties, raw));
            } else if (type.startsWith("permission.") && (type.endsWith(".replied") || type.endsWith(".rejected"))) {
                handle.seenAttentionRequests.remove(requestKey("permission", properties, raw));
            }
            return;
        }

        String sessionID = firstText(properties, "sessionID", "sessionId");
        if (sessionID == null) return;
        String family = questionAsked ? "question" : "permission";
        String key = requestKey(family, properties, raw);
        if (!handle.seenAttentionRequests.add(key)) return;

        String title;
        String body;
        if (permissionAsked) {
            title = "Authorization required";
            String action = firstText(properties, "permission", "title", "name");
            JSONObject metadata = properties.optJSONObject("metadata");
            String explanation = firstText(metadata, "reason", "description", "message");
            JSONArray patterns = properties.optJSONArray("patterns");
            String boundary = patterns != null && patterns.length() > 0 ? patterns.optString(0, "").trim() : "";
            body = compactBody(
                action != null ? action : "Permission requested",
                explanation,
                !boundary.isEmpty() ? "Boundary: " + boundary : null,
                "If you do nothing, this request stays blocked.",
                context.machineName + " · " + context.agentLabel
            );
        } else {
            title = "Input required";
            String question = null;
            JSONArray questions = properties.optJSONArray("questions");
            if (questions != null && questions.length() > 0) {
                JSONObject first = questions.optJSONObject(0);
                question = firstText(first, "question", "header");
            }
            body = compactBody(
                question != null ? question : "The coding agent is waiting for your input.",
                context.machineName + " · " + context.agentLabel
            );
        }
        showAttentionNotification(context, sessionID, key, title, body);
    }

    private String compactBody(String... parts) {
        StringBuilder body = new StringBuilder();
        for (String part : parts) {
            if (part == null) continue;
            String value = part.trim();
            if (value.isEmpty()) continue;
            if (body.length() > 0) body.append('\n');
            body.append(value);
            if (body.length() >= 1000) break;
        }
        return body.length() > 1000 ? body.substring(0, 1000) : body.toString();
    }

    private void ensureAttentionChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(ATTENTION_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            ATTENTION_CHANNEL_ID,
            "Harness Remote attention",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Coding-agent permissions and questions that require your attention");
        manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33 || getActivity() == null) return;
        if (getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        if (!notificationPermissionRequested.compareAndSet(false, true)) return;
        getActivity().runOnUiThread(() -> getActivity().requestPermissions(
            new String[] { Manifest.permission.POST_NOTIFICATIONS },
            NOTIFICATION_PERMISSION_REQUEST
        ));
    }

    private void showAttentionNotification(
        AttentionContext context,
        String sessionID,
        String requestKey,
        String title,
        String body
    ) {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        Uri target = new Uri.Builder()
            .scheme("harnessremote")
            .authority("attention")
            .appendQueryParameter("machineID", context.machineID)
            .appendQueryParameter("agentID", context.agentID)
            .appendQueryParameter("sessionID", sessionID)
            .build();
        Intent intent = new Intent(getContext(), MainActivity.class)
            .setAction("ai.harness.remote.ATTENTION." + Integer.toHexString((requestKey + sessionID).hashCode()))
            .setData(target)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        int notificationID = (context.machineID + context.agentID + sessionID + requestKey).hashCode() & 0x7fffffff;
        PendingIntent contentIntent = PendingIntent.getActivity(getContext(), notificationID, intent, pendingFlags);

        int smallIcon = getContext().getApplicationInfo().icon;
        if (smallIcon == 0) smallIcon = android.R.drawable.ic_dialog_info;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(getContext(), ATTENTION_CHANNEL_ID)
            : new Notification.Builder(getContext());
        builder
            .setSmallIcon(smallIcon)
            .setContentTitle(title)
            .setContentText(body.replace('\n', ' '))
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(contentIntent)
            .setAutoCancel(true);
        try {
            manager.notify(notificationID, builder.build());
        } catch (SecurityException ignored) {
            // Android 13+ may deny notification permission. The in-app Inbox remains authoritative.
        }
    }

    private void publishEvent(String subscriptionID, String data) {
        JSObject payload = new JSObject();
        payload.put("subscriptionID", subscriptionID);
        payload.put("data", data);
        notifyListeners("event", payload);
    }

    private void publishStatus(String subscriptionID, String type, String error, Integer delayMs) {
        JSObject payload = new JSObject();
        payload.put("subscriptionID", subscriptionID);
        payload.put("type", type);
        if (error != null) payload.put("error", error);
        if (delayMs != null) payload.put("delayMs", delayMs);
        notifyListeners("status", payload);
    }
}
