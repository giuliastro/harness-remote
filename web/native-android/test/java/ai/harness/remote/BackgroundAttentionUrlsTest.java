package ai.harness.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class BackgroundAttentionUrlsTest {
    @Test
    public void machineSnapshotUsesTheAuthenticatedMachineRoute() {
        assertEquals("http://127.0.0.1:4097/v1/machine", BackgroundAttentionUrls.machineSnapshot("http://127.0.0.1:4097"));
        assertEquals("https://studio.local:4097/v1/machine", BackgroundAttentionUrls.machineSnapshot("https://studio.local:4097/"));
    }

    @Test
    public void agentEventsStayInsideTheAgentScopedStream() {
        assertEquals(
            "http://127.0.0.1:4097/v1/agents/opencode/global/event",
            BackgroundAttentionUrls.agentEvents("http://127.0.0.1:4097", "opencode")
        );
        assertEquals(
            "http://127.0.0.1:4097/v1/agents/a%20b/global/event",
            BackgroundAttentionUrls.agentEvents("http://127.0.0.1:4097", "a b")
        );
        assertEquals(
            "http://127.0.0.1:4097/v1/agents/a%2Fb/global/event",
            BackgroundAttentionUrls.agentEvents("http://127.0.0.1:4097", "a/b")
        );
    }
}
