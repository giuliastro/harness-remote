package ai.harness.remote;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/** Scoped pinned HTTPS requests. An E1 profile never falls back to CapacitorHttp or WebView fetch. */
@CapacitorPlugin(name = "RemoteMachine")
public final class RemoteMachinePlugin extends Plugin {
    private static final int BASE64_FLAGS = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;
    private static final int MAX_BODY_BYTES = 24 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @Override protected void handleOnDestroy() {
        executor.shutdownNow();
    }

    @PluginMethod
    public void request(PluginCall call) {
        executor.execute(() -> {
            try {
                String endpoint = call.getString("endpoint");
                String machineID = call.getString("machineID");
                String dnsName = call.getString("dnsName");
                String pin = call.getString("pin");
                String method = call.getString("method", "GET");
                String target = call.getString("target");
                String body = call.getString("body");
                String backend = call.getString("backend", "");
                byte[] bodyBytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
                if (bodyBytes.length > MAX_BODY_BYTES || !validMachineID(machineID)
                    || !method.matches("[A-Z]{1,16}") || !validTarget(target)) {
                    throw new IllegalArgumentException("Invalid remote request");
                }
                URL url = endpointURL(endpoint, target);
                HttpsURLConnection connection = PinnedMachineTls.open(url, dnsName, pin);
                try {
                    connection.setRequestMethod(method);
                    connection.setConnectTimeout(12_000);
                    connection.setReadTimeout(Math.min(120_000, Math.max(1_000, call.getInt("readTimeout", 30_000))));
                    connection.setRequestProperty("Accept", "application/json");
                    if (body != null) connection.setRequestProperty("Content-Type", "application/json");
                    if (backend != null && !backend.isEmpty()) {
                        if (!backend.matches("[a-z0-9-]{1,32}")) throw new IllegalArgumentException("Invalid backend");
                        connection.setRequestProperty("X-Harness-Backend", backend);
                    }

                    signConnection(connection, machineID, pin, method, target, bodyBytes);
                    if (body != null) {
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(bodyBytes.length);
                        try (OutputStream output = connection.getOutputStream()) { output.write(bodyBytes); }
                    }
                    call.resolve(response(connection));
                } finally {
                    connection.disconnect();
                }
            } catch (Exception error) {
                call.reject("Remote machine request failed: " + error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void pair(PluginCall call) {
        executor.execute(() -> {
            try {
                String endpoint = call.getString("endpoint");
                String dnsName = call.getString("dnsName");
                String pin = call.getString("pin");
                String token = call.getString("token");
                String name = call.getString("name");
                if (token == null || !token.matches("[A-Za-z0-9_-]{1,256}") || name == null
                    || name.isEmpty() || name.length() > 80) throw new IllegalArgumentException("Invalid pairing grant");
                URL url = endpointURL(endpoint, "/v1/remote/pair");
                HttpsURLConnection connection = PinnedMachineTls.open(url, dnsName, pin);
                try {
                    connection.setRequestMethod("POST");
                    connection.setConnectTimeout(10_000);
                    connection.setReadTimeout(10_000);
                    connection.setRequestProperty("Accept", "application/json");
                    connection.setRequestProperty("Content-Type", "application/json");
                    JSONObject payload = new JSONObject();
                    payload.put("token", token);
                    payload.put("name", name);
                    payload.put("publicKey", base64Url(DeviceKeyPlugin.keyPair().getPublic().getEncoded()));
                    byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(body.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                    call.resolve(response(connection));
                } finally {
                    connection.disconnect();
                }
            } catch (Exception error) {
                call.reject("Remote pairing failed: " + error.getMessage(), error);
            }
        });
    }

    static String transcript(String machineID, String pin, String deviceID, long timestamp,
        String nonce, String method, String target, byte[] body) throws Exception {
        return "harness-remote-request-v1\n" + machineID + "\n" + pin + "\n" + deviceID
            + "\n" + timestamp + "\n" + nonce + "\n" + method + "\n" + target + "\n"
            + hex(sha256(body));
    }

    static HttpsURLConnection openSignedEventStream(String url, String machineID, String dnsName,
        String pin, String backend) throws Exception {
        if (!validMachineID(machineID) || backend == null || !backend.matches("[a-z0-9-]{1,32}")) {
            throw new IllegalArgumentException("Invalid remote stream identity");
        }
        URI uri = new URI(url);
        String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        if (!validTarget(target) || uri.getRawFragment() != null || uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("Invalid remote stream URL");
        }
        HttpsURLConnection connection = PinnedMachineTls.open(uri.toURL(), dnsName, pin);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("X-Harness-Backend", backend);
        signConnection(connection, machineID, pin, "GET", target, new byte[0]);
        return connection;
    }

    private static void signConnection(HttpsURLConnection connection, String machineID, String pin,
        String method, String target, byte[] body) throws Exception {
        KeyPair keyPair = DeviceKeyPlugin.keyPair();
        String deviceID = base64Url(sha256(keyPair.getPublic().getEncoded()));
        byte[] nonceBytes = new byte[32];
        new SecureRandom().nextBytes(nonceBytes);
        String nonce = base64Url(nonceBytes);
        long timestamp = System.currentTimeMillis();
        String message = transcript(machineID, pin, deviceID, timestamp, nonce, method, target, body);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(keyPair.getPrivate());
        signer.update(message.getBytes(StandardCharsets.UTF_8));
        connection.setRequestProperty("X-Harness-Device", deviceID);
        connection.setRequestProperty("X-Harness-Timestamp", Long.toString(timestamp));
        connection.setRequestProperty("X-Harness-Nonce", nonce);
        connection.setRequestProperty("X-Harness-Signature", base64Url(signer.sign()));
    }

    private static boolean validMachineID(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{1,128}");
    }

    private static boolean validTarget(String value) {
        return value != null && value.length() <= 4096 && value.startsWith("/") && !value.startsWith("//")
            && !value.matches(".*[\\x00-\\x1f\\x7f].*") && value.indexOf('#') < 0;
    }

    private static URL endpointURL(String endpoint, String target) throws Exception {
        if (endpoint == null) throw new IllegalArgumentException("Machine endpoint is required");
        URI uri = new URI(endpoint);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getPort() < 1
            || uri.getPort() > 65535 || uri.getRawUserInfo() != null || uri.getRawQuery() != null
            || uri.getRawFragment() != null || (uri.getRawPath() != null && !uri.getRawPath().isEmpty()
            && !"/".equals(uri.getRawPath()))) throw new IllegalArgumentException("Invalid HTTPS machine endpoint");
        return new URL(uri.toASCIIString().replaceAll("/$", "") + target);
    }

    private static byte[] sha256(byte[] value) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(value);
    }

    private static String base64Url(byte[] value) {
        return Base64.encodeToString(value, BASE64_FLAGS);
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            result[i * 2] = digits[(bytes[i] >> 4) & 15];
            result[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(result);
    }

    private static JSObject response(HttpsURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] bytes = stream == null ? new byte[0] : readBounded(stream);
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("data", new String(bytes, StandardCharsets.UTF_8));
        JSObject headers = new JSObject();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null && !entry.getValue().isEmpty()) {
                headers.put(entry.getKey().toLowerCase(java.util.Locale.ROOT), entry.getValue().get(0));
            }
        }
        result.put("headers", headers);
        return result;
    }

    private static byte[] readBounded(InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = stream.read(buffer)) >= 0) {
                if (output.size() + length > MAX_RESPONSE_BYTES) throw new IOException("Remote response is too large");
                output.write(buffer, 0, length);
            }
            return output.toByteArray();
        }
    }
}
