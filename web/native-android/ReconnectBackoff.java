package ai.harness.remote;

/** Bounded exponential reconnect so a sleeping phone cannot turn one dead socket into a tight loop. */
final class ReconnectBackoff {
    private final long initialMs;
    private final long maximumMs;
    private long nextMs;

    ReconnectBackoff(long initialMs, long maximumMs) {
        this.initialMs = Math.max(1L, initialMs);
        this.maximumMs = Math.max(this.initialMs, maximumMs);
        this.nextMs = this.initialMs;
    }

    synchronized long next() {
        long value = nextMs;
        nextMs = Math.min(maximumMs, nextMs * 2L);
        return value;
    }

    synchronized void reset() {
        nextMs = initialMs;
    }
}
