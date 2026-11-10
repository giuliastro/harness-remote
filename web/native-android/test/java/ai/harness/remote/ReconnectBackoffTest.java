package ai.harness.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class ReconnectBackoffTest {
    @Test
    public void doublesUntilTheCeilingAndResets() {
        ReconnectBackoff backoff = new ReconnectBackoff(1_000, 5_000);
        assertEquals(1_000, backoff.next());
        assertEquals(2_000, backoff.next());
        assertEquals(4_000, backoff.next());
        assertEquals(5_000, backoff.next());
        assertEquals(5_000, backoff.next());
        backoff.reset();
        assertEquals(1_000, backoff.next());
    }

    @Test
    public void rejectsAUsableButNonsensicalWindowWithoutGoingTight() {
        ReconnectBackoff backoff = new ReconnectBackoff(0, -10);
        assertEquals(1, backoff.next());
    }
}
