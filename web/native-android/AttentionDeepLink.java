package ai.harness.remote;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * Exact, private Android deep link for one native request. It carries only the identity the app
 * already uses to open the Attention Inbox; no transcript, prompt text or credentials.
 */
final class AttentionDeepLink {
    static final int MAX_ID_LENGTH = 512;

    private AttentionDeepLink() {}

    static String forRequest(String machineID, String agentID, String sessionID) {
        String machine = normalizeID(machineID);
        String agent = normalizeID(agentID);
        String session = normalizeID(sessionID);
        if (machine == null || agent == null || session == null) return null;
        return "harnessremote://attention"
            + "?machineID=" + encode(machine)
            + "&agentID=" + encode(agent)
            + "&sessionID=" + encode(session);
    }

    static boolean validID(String value) {
        return normalizeID(value) != null;
    }

    private static String normalizeID(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_ID_LENGTH) return null;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) return null;
        }
        String normalized = value.trim();
        return normalized.isEmpty() ? null : normalized;
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException impossible) {
            throw new AssertionError(impossible);
        }
    }
}
