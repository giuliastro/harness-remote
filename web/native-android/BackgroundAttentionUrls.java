package ai.harness.remote;

import android.util.Base64;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** URL and header construction kept separate so the endpoint shape is unit-testable. */
final class BackgroundAttentionUrls {
    private BackgroundAttentionUrls() {}

    static String machineSnapshot(String baseUrl) {
        return withoutTrailingSlash(baseUrl) + "/v1/machine";
    }

    static String agentEvents(String baseUrl, String agentID) {
        return withoutTrailingSlash(baseUrl) + "/v1/agents/" + encodePathSegment(agentID) + "/global/event";
    }

    static String encodePathSegment(String value) {
        try {
            // URLEncoder is form encoding; an agent id is a path segment and a literal space must not
            // become '+'. Everything else it escapes is safe for a path segment.
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException impossible) {
            throw new AssertionError(impossible);
        }
    }

    static String basicAuthorization(String username, String password) {
        String credentials = (username == null ? "" : username) + ":" + (password == null ? "" : password);
        return "Basic " + Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    private static String withoutTrailingSlash(String value) {
        String normalized = value == null ? "" : value.trim();
        while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
        return normalized;
    }
}
