package ai.harness.remote;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Process-local projection of the background service for the plugin status call and for the Android
 * instrumentation tests. It never contains credentials or transcript content.
 */
final class BackgroundAttentionStatus {
    private static final Set<String> connectedMachines = ConcurrentHashMap.newKeySet();
    private static final Map<String, Long> lastFrameAt = new ConcurrentHashMap<>();

    static volatile boolean running;
    static volatile int configuredMachines;
    static volatile String lastError;

    private BackgroundAttentionStatus() {}

    static void reset() {
        running = false;
        configuredMachines = 0;
        lastError = null;
        connectedMachines.clear();
        lastFrameAt.clear();
    }

    static void setMachineConnected(String machineID, boolean connected) {
        if (machineID == null || machineID.isEmpty()) return;
        if (connected) connectedMachines.add(machineID);
        else connectedMachines.remove(machineID);
    }

    static boolean isMachineConnected(String machineID) {
        return connectedMachines.contains(machineID);
    }

    static int connectedMachines() {
        return connectedMachines.size();
    }

    static void noteFrame(String machineID) {
        if (machineID == null || machineID.isEmpty()) return;
        lastFrameAt.put(machineID, System.currentTimeMillis());
    }

    static long lastFrameAt(String machineID) {
        Long value = lastFrameAt.get(machineID);
        return value == null ? 0L : value;
    }

    static void clearConnections() {
        connectedMachines.clear();
    }

    static void setLastError(String message) {
        if (message == null || message.trim().isEmpty()) {
            lastError = null;
            return;
        }
        String normalized = message.trim();
        lastError = normalized.length() > 280 ? normalized.substring(0, 280) : normalized;
    }
}
