package ai.harness.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class AttentionDeepLinkTest {
    @Test
    public void exactNativeIdentityBecomesThePrivateAttentionUri() {
        assertEquals(
            "harnessremote://attention?machineID=machine-1&agentID=opencode&sessionID=session-123",
            AttentionDeepLink.forRequest("machine-1", "opencode", "session-123")
        );
    }

    @Test
    public void identityIsEncodedWithoutLosingTheQueryShape() {
        assertEquals(
            "harnessremote://attention?machineID=machine%201&agentID=a%2Fb&sessionID=session-1",
            AttentionDeepLink.forRequest("machine 1", "a/b", "session-1")
        );
    }

    @Test
    public void invalidIdentityNeverProducesAUsableLink() {
        assertNull(AttentionDeepLink.forRequest(null, "opencode", "session-1"));
        assertNull(AttentionDeepLink.forRequest("machine-1", "", "session-1"));
        assertNull(AttentionDeepLink.forRequest("machine-1", "opencode", "bad\nsession"));
        assertNull(AttentionDeepLink.forRequest("m".repeat(513), "opencode", "session-1"));
        assertFalse(AttentionDeepLink.validID(""));
        assertTrue(AttentionDeepLink.validID("session-1"));
    }
}
