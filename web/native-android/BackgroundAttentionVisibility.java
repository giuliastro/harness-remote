package ai.harness.remote;

/**
 * Process-local foreground/session visibility shared by the Capacitor plugin and the background
 * service. The WebView sets the visible native Session; Android lifecycle sets foreground. The
 * service uses both so it never duplicates a completion notification for the Session on screen.
 */
final class BackgroundAttentionVisibility {
    private static boolean foreground;
    private static String machineID;
    private static String agentID;
    private static String sessionID;

    private BackgroundAttentionVisibility() {}

    static synchronized void setForeground(boolean value) {
        foreground = value;
    }

    static synchronized void setVisibleSession(String machine, String agent, String session) {
        if (!AttentionDeepLink.validID(machine) || !AttentionDeepLink.validID(agent) || !AttentionDeepLink.validID(session)) {
            clear();
            return;
        }
        machineID = machine.trim();
        agentID = agent.trim();
        sessionID = session.trim();
    }

    static synchronized void clear() {
        machineID = null;
        agentID = null;
        sessionID = null;
    }

    static synchronized boolean isVisible(String machine, String agent, String session) {
        return foreground
            && machineID != null
            && machineID.equals(machine)
            && agentID != null
            && agentID.equals(agent)
            && sessionID != null
            && sessionID.equals(session);
    }
}
