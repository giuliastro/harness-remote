package ai.harness.remote;

import org.json.JSONObject;

/** Normalize the turn lifecycle edges the native service needs for Ready/Failed notifications. */
final class SessionOutcomeParser {
    private static final int MAX_ID = 512;
    private static final int MAX_ERROR = 500;

    private SessionOutcomeParser() {}

    static SessionOutcomeEvent parse(
        String machineID,
        String machineName,
        String agentID,
        String agentLabel,
        String backend,
        String raw
    ) {
        if (!AttentionDeepLink.validID(machineID) || !AttentionDeepLink.validID(agentID) || raw == null || raw.isEmpty()) return null;
        JSONObject payload = eventPayload(raw);
        if (payload == null) return null;
        String type = payload.optString("type", "").trim();
        JSONObject properties = payload.optJSONObject("properties");
        String sessionID = sessionID(payload, properties);
        if (type.isEmpty() || sessionID == null) return null;

        SessionOutcomeEvent.Kind kind;
        String errorMessage = null;
        if ("session.idle".equals(type)) {
            kind = SessionOutcomeEvent.Kind.IDLE;
        } else if ("session.status".equals(type)) {
            JSONObject status = properties == null ? null : properties.optJSONObject("status");
            String statusType = status == null ? "" : status.optString("type", "").trim().toLowerCase(java.util.Locale.US);
            if ("busy".equals(statusType) || "retry".equals(statusType) || "waiting".equals(statusType)) {
                kind = SessionOutcomeEvent.Kind.WORKING;
            } else if ("idle".equals(statusType)) {
                kind = SessionOutcomeEvent.Kind.IDLE;
            } else {
                return null;
            }
        } else if ("session.error".equals(type) && "opencode".equals(backend)) {
            kind = SessionOutcomeEvent.Kind.FAILED;
            errorMessage = errorMessage(properties);
        } else {
            return null;
        }

        return new SessionOutcomeEvent(
            kind,
            machineID,
            machineName == null || machineName.trim().isEmpty() ? machineID : machineName.trim(),
            agentID,
            agentLabel == null || agentLabel.trim().isEmpty() ? agentID : agentLabel.trim(),
            sessionID,
            errorMessage
        );
    }

    private static JSONObject eventPayload(String raw) {
        try {
            JSONObject envelope = new JSONObject(raw);
            JSONObject payload = envelope.optJSONObject("payload");
            return payload != null ? payload : envelope;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String sessionID(JSONObject payload, JSONObject properties) {
        String value = cleanID(payload.optString("sessionID", ""));
        if (value == null) value = cleanID(payload.optString("sessionId", ""));
        if (value == null && properties != null) {
            value = cleanID(properties.optString("sessionID", ""));
            if (value == null) value = cleanID(properties.optString("sessionId", ""));
            if (value == null) {
                JSONObject info = properties.optJSONObject("info");
                if (info != null) {
                    value = cleanID(info.optString("sessionID", ""));
                    if (value == null) value = cleanID(info.optString("id", ""));
                }
            }
            if (value == null) {
                JSONObject session = properties.optJSONObject("session");
                if (session != null) value = cleanID(session.optString("id", ""));
            }
            if (value == null) {
                JSONObject part = properties.optJSONObject("part");
                if (part != null) {
                    value = cleanID(part.optString("sessionID", ""));
                    if (value == null) value = cleanID(part.optString("sessionId", ""));
                }
            }
        }
        return value;
    }

    private static String errorMessage(JSONObject properties) {
        if (properties == null) return null;
        JSONObject error = properties.optJSONObject("error");
        if (error != null) {
            String value = cleanError(error.optString("message", ""));
            if (value == null) {
                JSONObject data = error.optJSONObject("data");
                if (data != null) value = cleanError(data.optString("message", ""));
            }
            if (value == null) value = cleanError(error.optString("name", ""));
            if (value != null) return value;
        }
        return cleanError(properties.optString("error", ""));
    }

    private static String cleanID(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_ID) return null;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) return null;
        }
        String normalized = value.trim();
        return normalized.isEmpty() ? null : normalized;
    }

    private static String cleanError(String value) {
        if (value == null) return null;
        StringBuilder normalized = new StringBuilder();
        boolean space = false;
        for (int index = 0; index < value.length() && normalized.length() < MAX_ERROR; index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) {
                if (!space && normalized.length() > 0) {
                    normalized.append(' ');
                    space = true;
                }
                continue;
            }
            normalized.append(character);
            space = character == ' ';
        }
        String result = normalized.toString().trim();
        return result.isEmpty() ? null : result;
    }
}
