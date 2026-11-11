package ai.harness.remote;

/** One parsed permission/question transition from the authenticated agent stream. */
final class AttentionRequest {
    enum Kind {
        PERMISSION,
        QUESTION
    }

    enum Transition {
        ASKED,
        RESOLVED
    }

    final Transition transition;
    final Kind kind;
    final String machineID;
    final String machineName;
    final String agentID;
    final String agentLabel;
    final String sessionID;
    final String directory;
    final String requestID;
    final String action;
    final String explanation;
    final String boundary;
    final String question;
    final String fallbackKey;

    AttentionRequest(
        Transition transition,
        Kind kind,
        String machineID,
        String machineName,
        String agentID,
        String agentLabel,
        String sessionID,
        String directory,
        String requestID,
        String action,
        String explanation,
        String boundary,
        String question,
        String fallbackKey
    ) {
        this.transition = transition;
        this.kind = kind;
        this.machineID = machineID;
        this.machineName = machineName;
        this.agentID = agentID;
        this.agentLabel = agentLabel;
        this.sessionID = sessionID;
        this.directory = directory;
        this.requestID = requestID;
        this.action = action;
        this.explanation = explanation;
        this.boundary = boundary;
        this.question = question;
        this.fallbackKey = fallbackKey;
    }

    String family() {
        return kind == Kind.PERMISSION ? "permission" : "question";
    }

    String notificationKey() {
        String requestPart = requestID != null && !requestID.isEmpty() ? requestID : fallbackKey;
        return machineID + "\u0000" + agentID + "\u0000" + sessionID + "\u0000" + family() + "\u0000" + requestPart;
    }

    String resolutionPrefix() {
        return machineID + "\u0000" + agentID + "\u0000" + sessionID + "\u0000" + family() + "\u0000";
    }
}
