package ai.harness.remote;

import org.json.JSONArray;
import org.json.JSONObject;

/** Extract only the permission/question transitions the native notification layer needs. */
final class AttentionEventParser {
    private static final int MAX_ID = 512;
    private static final int MAX_TEXT = 1000;
    private static final int MAX_BOUNDARY = 300;

    private AttentionEventParser() {}

    static AttentionRequest parse(
        String machineID,
        String machineName,
        String agentID,
        String agentLabel,
        boolean questions,
        boolean permissions,
        String raw
    ) {
        if (!AttentionDeepLink.validID(machineID) || !AttentionDeepLink.validID(agentID) || raw == null || raw.isEmpty()) return null;
        JSONObject payload = eventPayload(raw);
        if (payload == null) return null;
        String type = payload.optString("type", "").trim();
        if (type.isEmpty()) return null;
        JSONObject properties = payload.optJSONObject("properties");
        if (properties == null) return null;

        boolean questionAsked = questions && ("question.asked".equals(type) || "question.v2.asked".equals(type));
        boolean permissionAsked = permissions && ("permission.asked".equals(type) || "permission.v2.asked".equals(type));
        boolean questionResolved = type.startsWith("question.")
            && (type.endsWith(".replied") || type.endsWith(".rejected"));
        boolean permissionResolved = type.startsWith("permission.")
            && (type.endsWith(".replied") || type.endsWith(".rejected"));
        if (!questionAsked && !permissionAsked && !questionResolved && !permissionResolved) return null;

        AttentionRequest.Kind kind = questionAsked || questionResolved
            ? AttentionRequest.Kind.QUESTION
            : AttentionRequest.Kind.PERMISSION;
        AttentionRequest.Transition transition = questionAsked || permissionAsked
            ? AttentionRequest.Transition.ASKED
            : AttentionRequest.Transition.RESOLVED;

        String sessionID = firstID(properties, "sessionID", "sessionId");
        if (sessionID == null) {
            JSONObject session = properties.optJSONObject("session");
            if (session != null) sessionID = firstID(session, "id", "sessionID");
        }
        if (sessionID == null) {
            JSONObject info = properties.optJSONObject("info");
            if (info != null) sessionID = firstID(info, "sessionID", "id");
        }
        if (sessionID == null) return null;

        String requestID = firstID(properties, "id", "requestID", "permissionID", "questionID");
        if (requestID == null) {
            JSONObject request = properties.optJSONObject("request");
            if (request != null) requestID = firstID(request, "id", "requestID");
        }

        String action = null;
        String explanation = null;
        String boundary = null;
        String question = null;
        if (transition == AttentionRequest.Transition.ASKED) {
            if (kind == AttentionRequest.Kind.PERMISSION) {
                action = firstText(properties, "permission", "title", "name");
                JSONObject metadata = properties.optJSONObject("metadata");
                explanation = firstText(metadata, "reason", "description", "message");
                if (explanation == null) explanation = firstText(properties, "reason", "description", "message");
                boundary = boundary(properties);
            } else {
                JSONArray questionList = properties.optJSONArray("questions");
                if (questionList != null && questionList.length() > 0) {
                    JSONObject first = questionList.optJSONObject(0);
                    question = firstText(first, "question", "header");
                }
                if (question == null) question = firstText(properties, "question", "header");
            }
        }

        String seed = sessionID + "\u0000" + type + "\u0000" + (action != null ? action : question);
        String fallbackKey = Integer.toHexString(seed.hashCode());
        return new AttentionRequest(
            transition,
            kind,
            machineID,
            machineName == null || machineName.trim().isEmpty() ? machineID : machineName.trim(),
            agentID,
            agentLabel == null || agentLabel.trim().isEmpty() ? agentID : agentLabel.trim(),
            sessionID,
            requestID,
            action,
            explanation,
            boundary,
            question,
            fallbackKey
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

    private static String firstID(JSONObject object, String... names) {
        if (object == null) return null;
        for (String name : names) {
            String value = cleanID(object.optString(name, ""));
            if (value != null) return value;
        }
        return null;
    }

    private static String firstText(JSONObject object, String... names) {
        if (object == null) return null;
        for (String name : names) {
            String value = cleanText(object.optString(name, ""), MAX_TEXT);
            if (value != null) return value;
        }
        return null;
    }

    private static String boundary(JSONObject properties) {
        JSONArray patterns = properties.optJSONArray("patterns");
        if (patterns != null) {
            StringBuilder joined = new StringBuilder();
            for (int index = 0; index < patterns.length() && index < 3; index++) {
                String value = cleanText(patterns.optString(index, ""), MAX_BOUNDARY);
                if (value == null) continue;
                if (joined.length() > 0) joined.append(", ");
                joined.append(value);
                if (joined.length() >= MAX_BOUNDARY) break;
            }
            if (joined.length() > 0) {
                return joined.length() > MAX_BOUNDARY ? joined.substring(0, MAX_BOUNDARY) : joined.toString();
            }
        }
        return firstText(properties, "pattern", "boundary");
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

    private static String cleanText(String value, int maximum) {
        if (value == null) return null;
        StringBuilder normalized = new StringBuilder();
        boolean previousSpace = false;
        for (int index = 0; index < value.length() && normalized.length() < maximum; index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) {
                if (!previousSpace && normalized.length() > 0) {
                    normalized.append(' ');
                    previousSpace = true;
                }
                continue;
            }
            normalized.append(character);
            previousSpace = character == ' ';
        }
        String result = normalized.toString().trim();
        return result.isEmpty() ? null : result;
    }
}
