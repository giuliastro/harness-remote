package ai.harness.remote;

/** One normalized turn-lifecycle edge for a native Session. */
final class SessionOutcomeEvent {
    enum Kind {
        WORKING,
        IDLE,
        FAILED
    }

    final Kind kind;
    final String machineID;
    final String machineName;
    final String agentID;
    final String agentLabel;
    final String sessionID;
    final String errorMessage;

    SessionOutcomeEvent(
        Kind kind,
        String machineID,
        String machineName,
        String agentID,
        String agentLabel,
        String sessionID,
        String errorMessage
    ) {
        this.kind = kind;
        this.machineID = machineID;
        this.machineName = machineName;
        this.agentID = agentID;
        this.agentLabel = agentLabel;
        this.sessionID = sessionID;
        this.errorMessage = errorMessage;
    }

    String sessionKey() {
        return machineID + "\u0000" + agentID + "\u0000" + sessionID;
    }
}
