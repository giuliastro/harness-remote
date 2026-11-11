package ai.harness.remote;

import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Set;

/** Bounded, process-local exactly-once guard for native notification permission replies. */
final class PermissionReplyTracker {
    private static final int MAX_COMPLETED = 200;

    private final Set<String> inFlight = new HashSet<>();
    private final LinkedHashMap<String, Boolean> completed = new LinkedHashMap<>();

    synchronized boolean begin(String key) {
        if (key == null || key.isEmpty() || completed.containsKey(key) || inFlight.contains(key)) return false;
        inFlight.add(key);
        return true;
    }

    synchronized void finish(String key, boolean success) {
        inFlight.remove(key);
        if (!success) return;
        completed.put(key, true);
        while (completed.size() > MAX_COMPLETED) {
            Iterator<String> iterator = completed.keySet().iterator();
            if (!iterator.hasNext()) break;
            iterator.next();
            iterator.remove();
        }
    }

    synchronized void clear() {
        inFlight.clear();
        completed.clear();
    }
}
