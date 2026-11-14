package ai.harness.remote;

import android.util.Base64;

import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;

import javax.net.ssl.HttpsURLConnection;

/** Signed, leaf-pinned requests used by the Android background service for paired remote machines. */
final class SignedMachineHttp {
    private static final int BASE64_FLAGS = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;

    private SignedMachineHttp() {}

    static HttpsURLConnection open(String endpoint, String machineID, String dnsName, String pin,
        String method, byte[] body) throws Exception {
        URI uri = new URI(endpoint);
        String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
            || uri.getRawUserInfo() != null || uri.getRawFragment() != null
            || !machineID.matches("[A-Za-z0-9_-]{1,128}")
            || !target.startsWith("/") || target.startsWith("//") || target.length() > 4096
            || target.matches(".*[\\x00-\\x1f\\x7f].*")) {
            throw new IllegalArgumentException("Invalid signed machine request");
        }
        if (!"GET".equals(method) && !"POST".equals(method)) {
            throw new IllegalArgumentException("Unsupported signed machine method");
        }
        byte[] requestBody = body == null ? new byte[0] : body;
        if ("GET".equals(method) && requestBody.length != 0) {
            throw new IllegalArgumentException("Signed GET requests must not have a body");
        }
        HttpsURLConnection connection = PinnedMachineTls.open(uri.toURL(), dnsName, pin);
        try {
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            KeyPair keyPair = DeviceKeyPlugin.keyPair();
            String deviceID = base64Url(sha256(keyPair.getPublic().getEncoded()));
            byte[] nonceBytes = new byte[32];
            new SecureRandom().nextBytes(nonceBytes);
            String nonce = base64Url(nonceBytes);
            long timestamp = System.currentTimeMillis();
            String transcript = RemoteMachinePlugin.transcript(machineID, pin, deviceID,
                timestamp, nonce, method, target, requestBody);
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(keyPair.getPrivate());
            signer.update(transcript.getBytes(StandardCharsets.UTF_8));
            connection.setRequestProperty("X-Harness-Device", deviceID);
            connection.setRequestProperty("X-Harness-Timestamp", Long.toString(timestamp));
            connection.setRequestProperty("X-Harness-Nonce", nonce);
            connection.setRequestProperty("X-Harness-Signature", base64Url(signer.sign()));
            if ("POST".equals(method)) {
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(requestBody.length);
            }
            return connection;
        } catch (Exception error) {
            connection.disconnect();
            throw error;
        }
    }

    private static byte[] sha256(byte[] input) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(input);
    }

    private static String base64Url(byte[] value) {
        return Base64.encodeToString(value, BASE64_FLAGS);
    }

}
