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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "LiveEvents")
public class LiveEventsPlugin extends Plugin {
    private static final int CONNECT_TIMEOUT_MS = 10000;
    // The daemon writes an SSE heartbeat every 10 seconds. A 30 second period with no bytes means
    // the socket is stale after sleep, backgrounding, Wi-Fi handoff or a brief network loss. The
    // previous infinite read timeout could leave Android permanently blocked in readLine() while the
    // native Session kept working. Let the existing reconnect loop own that failure instead.
    private static final int STALL_TIMEOUT_MS = 30000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean stopped = new AtomicBoolean(true);
    private volatile Future<?> task;
    private volatile HttpURLConnection connection;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        if (url == null || url.isEmpty()) {
            call.reject("Missing event stream URL");
            return;
        }
        stopStream();
        stopped.set(false);
        task = executor.submit(() -> runStream(url, username, password));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopStream();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopStream();
        executor.shutdownNow();
    }

    private void stopStream() {
        stopped.set(true);
        HttpURLConnection activeConnection = connection;
        if (activeConnection != null) activeConnection.disconnect();
        Future<?> activeTask = task;
        if (activeTask != null) activeTask.cancel(true);
        connection = null;
        task = null;
        publishStatus("closed", null, null);
    }

    private void runStream(String endpoint, String username, String password) {
        int delayMs = 1000;
        while (!stopped.get()) {
            try {
                HttpURLConnection current = (HttpURLConnection) new URL(endpoint).openConnection();
                connection = current;
                current.setRequestMethod("GET");
                current.setRequestProperty("Accept", "text/event-stream");
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
                publishStatus("connected", null, null);
                readFrames(current.getInputStream());
            } catch (Exception error) {
                if (stopped.get()) break;
                publishStatus("connection-error", error.getMessage(), null);
            } finally {
                HttpURLConnection current = connection;
                if (current != null) current.disconnect();
                connection = null;
            }
            if (!stopped.get()) {
                publishStatus("reconnecting", null, delayMs);
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

    private void readFrames(InputStream inputStream) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            StringBuilder data = new StringBuilder();
            String line;
            while (!stopped.get() && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        publishEvent(data.toString());
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

    private void publishEvent(String data) {
        JSObject payload = new JSObject();
        payload.put("data", data);
        notifyListeners("event", payload);
    }

    private void publishStatus(String type, String error, Integer delayMs) {
        JSObject payload = new JSObject();
        payload.put("type", type);
        if (error != null) payload.put("error", error);
        if (delayMs != null) payload.put("delayMs", delayMs);
        notifyListeners("status", payload);
    }
}
