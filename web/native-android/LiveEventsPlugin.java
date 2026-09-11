package ai.harness.remote;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
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

    /**
     * One Android plugin instance serves the whole WebView. Session detail, the global Attention
     * Inbox and multiple machines may all subscribe concurrently, so stream ownership must be keyed
     * instead of letting the most recent start() cancel every earlier socket.
     */
    private static final class StreamHandle {
        final AtomicBoolean stopped = new AtomicBoolean(false);
        volatile Future<?> task;
        volatile HttpURLConnection connection;
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

        // Replacing the same logical subscription is safe and does not disturb any sibling stream.
        stopStream(subscriptionID, false);
        StreamHandle handle = new StreamHandle();
        streams.put(subscriptionID, handle);
        handle.task = executor.submit(() -> runStream(subscriptionID, handle, url, username, password, backend));
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
                        publishEvent(subscriptionID, data.toString());
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
