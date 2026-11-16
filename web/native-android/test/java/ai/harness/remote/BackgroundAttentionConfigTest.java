package ai.harness.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class BackgroundAttentionConfigTest {
    private static final String MACHINE_ID = "m-0123456789abcdef0123456789abcdef";
    private static final String DNS_NAME = "m-0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef.machine.harness-remote.invalid";
    private static final String PIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test
    public void acceptsOnlyCompleteHttpsPinnedRemoteIdentity() {
        assertTrue(BackgroundAttentionConfig.validRemoteIdentity(
            "https://192.0.2.4:4097", MACHINE_ID, DNS_NAME, PIN));
        assertFalse(BackgroundAttentionConfig.validRemoteIdentity(
            "http://192.0.2.4:4097", MACHINE_ID, DNS_NAME, PIN));
        assertFalse(BackgroundAttentionConfig.validRemoteIdentity(
            "https://192.0.2.4:4097", MACHINE_ID, DNS_NAME, "bad"));
        assertFalse(BackgroundAttentionConfig.validRemoteIdentity(
            "https://192.0.2.4:4097", MACHINE_ID, "machine.example.test", PIN));
        assertFalse(BackgroundAttentionConfig.validRemoteIdentity(
            "https://192.0.2.4:4097", "../machine", DNS_NAME, PIN));
        assertFalse(BackgroundAttentionConfig.validRemoteIdentity(
            "https://192.0.2.4:4097", MACHINE_ID, DNS_NAME, null));
    }

    @Test
    public void remoteIdentityChangesReplaceTheBackgroundConnection() {
        BackgroundAttentionConfig.Machine current = new BackgroundAttentionConfig.Machine(
            "workspace-machine", "Remote", "https://192.0.2.4:4097", "", "",
            MACHINE_ID, DNS_NAME, PIN);
        BackgroundAttentionConfig.Machine same = new BackgroundAttentionConfig.Machine(
            "workspace-machine", "Remote", "https://192.0.2.4:4097", "", "",
            MACHINE_ID, DNS_NAME, PIN);
        BackgroundAttentionConfig.Machine changedPin = new BackgroundAttentionConfig.Machine(
            "workspace-machine", "Remote", "https://192.0.2.4:4097", "", "",
            MACHINE_ID, DNS_NAME, PIN.replace('a', 'b'));
        assertTrue(current.isRemote());
        assertTrue(current.sameConnection(same));
        assertFalse(current.sameConnection(changedPin));
    }

    @Test
    public void legacyLanConfigurationRemainsNonRemote() {
        BackgroundAttentionConfig.Machine lan = new BackgroundAttentionConfig.Machine(
            "lan-machine", "LAN", "http://192.168.1.9:4097", "harness", "secret",
            null, null, null);
        assertFalse(lan.isRemote());
        assertEquals("http://192.168.1.9:4097", lan.baseUrl);
    }
}
