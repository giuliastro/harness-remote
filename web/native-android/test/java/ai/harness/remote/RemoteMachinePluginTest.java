package ai.harness.remote;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;

public class RemoteMachinePluginTest {
    @Test
    public void requestTranscriptMatchesTheGatewayWireFormat() throws Exception {
        String actual = RemoteMachinePlugin.transcript(
            "machine-123",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            1900000000000L,
            "ccccccccccccccccccccccccccccccccccccccccccc",
            "POST",
            "/v1/sessions?agent=codex",
            "{\"prompt\":\"hello\"}".getBytes(StandardCharsets.UTF_8)
        );
        assertEquals(
            "harness-remote-request-v1\nmachine-123\n"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n1900000000000\n"
                + "ccccccccccccccccccccccccccccccccccccccccccc\nPOST\n"
                + "/v1/sessions?agent=codex\n"
                + "8a44725210b9dcd4fefd9f0eca07b70ae45e69274a3105fb25eb426a2cf8bbf4",
            actual
        );
    }
}
