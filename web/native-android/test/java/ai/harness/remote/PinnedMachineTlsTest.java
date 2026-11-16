package ai.harness.remote;

import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.net.SocketException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;

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

    @Test
    public void pinnedHandshakeAcceptsExactIdentityAndRejectsWrongPinOrDnsSan() throws Exception {
        X509Certificate good = certificate("e1-test-cert.pem");
        X509Certificate wrongDns = certificate("e1-test-wrong-dns-cert.pem");
        String pin = hex(MessageDigest.getInstance("SHA-256").digest(good.getPublicKey().getEncoded()));
        TestServer goodServer = startServer(good);
        TestServer wrongDnsServer = startServer(wrongDns);
        try {
            URL goodUrl = new URL("https://127.0.0.1:" + goodServer.port() + "/");
            HttpsURLConnection accepted = PinnedMachineTls.open(goodUrl, "test.machine.invalid", pin);
            try {
                assertEquals(200, accepted.getResponseCode());
            } finally {
                accepted.disconnect();
            }
            assertHandshakeRejected(goodUrl, "test.machine.invalid", "0".repeat(64));
            URL wrongDnsUrl = new URL("https://127.0.0.1:" + wrongDnsServer.port() + "/");
            assertHandshakeRejected(wrongDnsUrl, "test.machine.invalid", pin);
        } finally {
            goodServer.close();
            wrongDnsServer.close();
        }
    }

    private static void assertHandshakeRejected(URL url, String dnsName, String pin) throws Exception {
        HttpsURLConnection connection = PinnedMachineTls.open(url, dnsName, pin);
        try {
            try {
                connection.getResponseCode();
                fail("Expected the pinned handshake to fail");
            } catch (IOException expected) {
                // Wrong pin or DNS SAN must fail before an HTTP response is accepted.
            }
        } finally {
            connection.disconnect();
        }
    }

    private static TestServer startServer(X509Certificate certificate) throws Exception {
        String pem = resourceText("e1-test-key.pem");
        String encoded = pem.replaceAll("-----[^-]+-----", "").replaceAll("\\s", "");
        PrivateKey key = KeyFactory.getInstance("EC").generatePrivate(
            new PKCS8EncodedKeySpec(Base64.getDecoder().decode(encoded)));
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setKeyEntry("machine", key, "fixture".toCharArray(), new java.security.cert.Certificate[] { certificate });
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, "fixture".toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), null, null);
        return new TestServer((SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 8,
            java.net.InetAddress.getByName("127.0.0.1")));
    }

    private static final class TestServer implements AutoCloseable {
        private final SSLServerSocket listener;
        private final Thread worker;

        TestServer(SSLServerSocket listener) {
            this.listener = listener;
            worker = new Thread(() -> {
                while (!listener.isClosed()) {
                    try (SSLSocket socket = (SSLSocket) listener.accept()) {
                        socket.setSoTimeout(3_000);
                        socket.startHandshake();
                        byte[] request = new byte[4096];
                        socket.getInputStream().read(request);
                        byte[] response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                            .getBytes(StandardCharsets.US_ASCII);
                        socket.getOutputStream().write(response);
                        socket.getOutputStream().flush();
                    } catch (SocketException closed) {
                        if (!listener.isClosed()) throw new RuntimeException(closed);
                    } catch (IOException handshakeFailure) {
                        // Negative handshake cases close the connection before an HTTP request.
                    }
                }
            }, "pinned-machine-test-server");
            worker.setDaemon(true);
            worker.start();
        }

        int port() { return listener.getLocalPort(); }

        @Override public void close() throws Exception {
            listener.close();
            worker.join(3_000);
        }
    }

    private static X509Certificate certificate(String name) throws Exception {
        try (InputStream input = PinnedMachineTlsTest.class.getResourceAsStream("/ai/harness/remote/" + name)) {
            if (input == null) throw new IOException("Missing test certificate " + name);
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
    }

    private static String resourceText(String name) throws Exception {
        try (InputStream input = PinnedMachineTlsTest.class.getResourceAsStream("/ai/harness/remote/" + name)) {
            if (input == null) throw new IOException("Missing test key " + name);
            return new String(input.readAllBytes(), StandardCharsets.US_ASCII);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) value.append(String.format("%02x", b & 0xff));
        return value.toString();
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
