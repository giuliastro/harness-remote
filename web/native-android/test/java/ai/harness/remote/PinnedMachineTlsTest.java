package ai.harness.remote;

import org.junit.Test;

import java.net.URL;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class PinnedMachineTlsTest {
    @Test
    public void acceptsOnlyLowercaseHexSha256Pins() {
        byte[] expected = new byte[32];
        java.util.Arrays.fill(expected, (byte) 0xaa);
        String encoded = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        assertArrayEquals(expected, PinnedMachineTls.decodePin(encoded));
        assertIllegalArgument(() -> PinnedMachineTls.decodePin(encoded + "0"));
        assertIllegalArgument(() -> PinnedMachineTls.decodePin(encoded.toUpperCase()));
        assertIllegalArgument(() -> PinnedMachineTls.decodePin("zz00000000000000000000000000000000000000000000000000000000000000"));
        assertIllegalArgument(() -> PinnedMachineTls.decodePin("not a pin"));
    }

    @Test
    public void requiresAStableQualifiedDnsIdentity() {
        assertEquals("studio.example.test", PinnedMachineTls.normalizeDnsName("Studio.Example.Test."));
        assertIllegalArgument(() -> PinnedMachineTls.normalizeDnsName("192.168.1.8"));
        assertIllegalArgument(() -> PinnedMachineTls.normalizeDnsName("machine"));
        assertIllegalArgument(() -> PinnedMachineTls.normalizeDnsName("bad..example.test"));
    }

    @Test
    public void dnsSanMatchingRequiresExactMachineName() {
        assertTrue(PinnedMachineTls.dnsSanMatches("studio.example.test", "studio.example.test"));
        assertFalse(PinnedMachineTls.dnsSanMatches("studio.example.test", "*.example.test"));
        assertFalse(PinnedMachineTls.dnsSanMatches("example.test", "*.example.test"));
        assertFalse(PinnedMachineTls.dnsSanMatches("deep.studio.example.test", "*.example.test"));
        assertFalse(PinnedMachineTls.dnsSanMatches("studio.example.test", "other.example.test"));
        assertFalse(PinnedMachineTls.dnsSanMatches("studio.example.test", "studio.example.test.evil"));
    }

    @Test
    public void refusesPlainHttpAndInvalidPinBeforeOpeningConnection() throws Exception {
        String pin = "0000000000000000000000000000000000000000000000000000000000000000";
        try {
            PinnedMachineTls.open(new URL("http://studio.example.test"), "studio.example.test", pin);
            fail("Expected HTTP endpoint rejection");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("HTTPS"));
        }

        try {
            PinnedMachineTls.open(new URL("https://studio.example.test"), "studio.example.test", "bad");
            fail("Expected invalid pin rejection");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("pin"));
        }
    }

    private static void assertIllegalArgument(Runnable action) {
        try {
            action.run();
            fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // Expected fail-closed input validation.
        }
    }
}
