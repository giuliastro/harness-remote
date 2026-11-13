package ai.harness.remote;

import java.io.IOException;
import java.net.IDN;
import java.net.URL;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.AlgorithmParameters;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.util.Collection;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import javax.net.ssl.SNIHostName;

/**
 * Creates an HTTPS connection for a paired machine using its QR-provided SPKI pin and
 * stable DNS identity. The self-signed machine leaf is trusted only when its exact
 * public-key pin, validity, key type, usage, and DNS identity all match.
 *
 * <p>This class is intentionally not installed globally and does not change WebView TLS
 * handling. Callers remain responsible for configuring timeouts, request headers, and
 * disconnecting the connection.</p>
 */
public final class PinnedMachineTls {
    private PinnedMachineTls() {}

    /**
     * Opens an HTTPS URL with a leaf SPKI SHA-256 pin, certificate validity checks, and a
     * DNS SAN check against {@code expectedMachineDns}. The expected identity is used
     * for TLS SNI and certificate name verification even if the URL host is an address.
     *
     * @param url HTTPS endpoint to contact
     * @param expectedMachineDns stable DNS name recorded during pairing
     * @param sha256SpkiPin lowercase hexadecimal SHA-256 of the leaf SPKI
     */
    public static HttpsURLConnection open(
        URL url,
        String expectedMachineDns,
        String sha256SpkiPin
    ) throws IOException, GeneralSecurityException {
        if (url == null) throw new IllegalArgumentException("URL is required");
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new IllegalArgumentException("Pinned machine connections require HTTPS");
        }

        final String dnsName = normalizeDnsName(expectedMachineDns);
        final byte[] expectedPin = decodePin(sha256SpkiPin);
        final X509TrustManager pinningTrustManager = new PinningTrustManager(expectedPin, dnsName);

        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { pinningTrustManager }, null);

        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setSSLSocketFactory(new SniSocketFactory(context.getSocketFactory(), dnsName));
        connection.setHostnameVerifier((ignoredUrlHost, session) -> verifyDnsIdentity(dnsName, session));
        return connection;
    }

    static byte[] decodePin(String encoded) {
        if (encoded == null || !encoded.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("SPKI pin must be 64 lowercase hexadecimal characters");
        }
        byte[] pin = new byte[32];
        for (int i = 0; i < pin.length; i++) {
            int high = Character.digit(encoded.charAt(i * 2), 16);
            int low = Character.digit(encoded.charAt(i * 2 + 1), 16);
            pin[i] = (byte) ((high << 4) | low);
        }
        return pin;
    }

    static String normalizeDnsName(String value) {
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException("Machine DNS identity is required");
        String input = value.trim();
        if (input.endsWith(".")) input = input.substring(0, input.length() - 1);
        if (input.isEmpty() || input.indexOf(':') >= 0) throw new IllegalArgumentException("Machine identity must be a DNS name");
        final String ascii;
        try {
            ascii = IDN.toASCII(input, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException invalidName) {
            throw new IllegalArgumentException("Machine identity must be a valid DNS name", invalidName);
        }
        if (ascii.length() > 253 || ascii.indexOf('.') < 0) throw new IllegalArgumentException("Machine identity must be a fully qualified DNS name");
        for (String label : ascii.split("\\.", -1)) {
            if (label.isEmpty() || label.length() > 63 || label.startsWith("-") || label.endsWith("-")) {
                throw new IllegalArgumentException("Machine identity must be a valid DNS name");
            }
        }
        // Avoid treating an IP literal as a DNS identity (including dotted IPv4 literals).
        if (ascii.matches("[0-9.]+")) throw new IllegalArgumentException("Machine identity must be a DNS name, not an IP address");
        return ascii;
    }

    private static boolean verifyDnsIdentity(String expectedDns, SSLSession session) {
        if (session == null) return false;
        try {
            Certificate[] peer = session.getPeerCertificates();
            if (peer.length == 0 || !(peer[0] instanceof X509Certificate)) return false;
            Collection<List<?>> names = ((X509Certificate) peer[0]).getSubjectAlternativeNames();
            if (names == null) return false;
            for (List<?> entry : names) {
                if (entry.size() < 2 || !(entry.get(0) instanceof Integer) || ((Integer) entry.get(0)) != 2) continue;
                Object value = entry.get(1);
                if (value instanceof String && dnsSanMatches(expectedDns, (String) value)) return true;
            }
        } catch (Exception ignored) {
            // Missing/unreadable peer identity is a hard failure.
        }
        return false;
    }

    static boolean dnsSanMatches(String expectedDns, String san) {
        if (expectedDns == null || san == null) return false;
        String expected = expectedDns.toLowerCase(Locale.ROOT);
        String candidate = san.toLowerCase(Locale.ROOT);
        if (!candidate.startsWith("*.")) return expected.equals(candidate);
        String suffix = candidate.substring(2);
        if (suffix.isEmpty() || !expected.endsWith("." + suffix)) return false;
        String prefix = expected.substring(0, expected.length() - suffix.length() - 1);
        return !prefix.isEmpty() && prefix.indexOf('.') < 0;
    }

    private static final class PinningTrustManager implements X509TrustManager {
        private final byte[] expectedPin;
        private final String expectedDns;

        PinningTrustManager(byte[] expectedPin, String expectedDns) {
            this.expectedPin = expectedPin.clone();
            this.expectedDns = expectedDns;
        }

        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("Client certificates are not accepted");
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0 || chain[0] == null) throw new CertificateException("Empty server certificate chain");
            X509Certificate leaf = chain[0];
            leaf.checkValidity();
            verifyLeafIdentityAndUsage(leaf, expectedDns);
            try {
                byte[] actual = MessageDigest.getInstance("SHA-256").digest(leaf.getPublicKey().getEncoded());
                if (!MessageDigest.isEqual(expectedPin, actual)) throw new CertificateException("Machine SPKI pin mismatch");
            } catch (GeneralSecurityException failure) {
                if (failure instanceof CertificateException) throw (CertificateException) failure;
                throw new CertificateException("Unable to verify machine SPKI pin", failure);
            }
        }

        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    private static void verifyLeafIdentityAndUsage(X509Certificate leaf, String expectedDns) throws CertificateException {
        if (!(leaf.getPublicKey() instanceof java.security.interfaces.ECPublicKey)) {
            throw new CertificateException("Machine certificate key must be EC P-256");
        }
        java.security.interfaces.ECPublicKey ecKey = (java.security.interfaces.ECPublicKey) leaf.getPublicKey();
        verifyP256(ecKey.getParams());
        boolean[] keyUsage = leaf.getKeyUsage();
        if (keyUsage != null && (keyUsage.length == 0 || !keyUsage[0])) {
            throw new CertificateException("Machine certificate does not permit digital signatures");
        }
        try {
            List<String> extendedUsage = leaf.getExtendedKeyUsage();
            if (extendedUsage != null
                && !extendedUsage.contains("1.3.6.1.5.5.7.3.1")
                && !extendedUsage.contains("2.5.29.37.0")) {
                throw new CertificateException("Machine certificate does not permit TLS server authentication");
            }
            Collection<List<?>> names = leaf.getSubjectAlternativeNames();
            if (names == null) throw new CertificateException("Machine certificate has no DNS subject alternative name");
            for (List<?> entry : names) {
                if (entry.size() < 2 || !(entry.get(0) instanceof Integer) || ((Integer) entry.get(0)) != 2) continue;
                Object value = entry.get(1);
                if (value instanceof String && dnsSanMatches(expectedDns, (String) value)) return;
            }
        } catch (CertificateException failure) {
            throw failure;
        } catch (Exception failure) {
            throw new CertificateException("Unable to verify machine certificate DNS identity", failure);
        }
        throw new CertificateException("Machine certificate DNS identity mismatch");
    }

    private static void verifyP256(ECParameterSpec actual) throws CertificateException {
        if (actual == null) throw new CertificateException("Machine certificate key must be EC P-256");
        try {
            AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
            parameters.init(new ECGenParameterSpec("secp256r1"));
            ECParameterSpec expected = parameters.getParameterSpec(ECParameterSpec.class);
            boolean matches = actual.getCurve().equals(expected.getCurve())
                && actual.getGenerator().equals(expected.getGenerator())
                && actual.getOrder().equals(expected.getOrder())
                && actual.getCofactor() == expected.getCofactor();
            if (!matches) throw new CertificateException("Machine certificate key must be EC P-256");
        } catch (CertificateException failure) {
            throw failure;
        } catch (GeneralSecurityException failure) {
            throw new CertificateException("Unable to validate EC P-256 parameters", failure);
        }
    }

    /** Adds the paired identity as SNI without changing the selected network destination. */
    private static final class SniSocketFactory extends SSLSocketFactory {
        private final SSLSocketFactory delegate;
        private final String dnsName;

        SniSocketFactory(SSLSocketFactory delegate, String dnsName) {
            this.delegate = delegate;
            this.dnsName = dnsName;
        }

        private java.net.Socket configure(java.net.Socket socket) throws IOException {
            if (!(socket instanceof SSLSocket)) throw new IOException("TLS provider did not create an SSL socket");
            SSLSocket ssl = (SSLSocket) socket;
            SSLParameters parameters = ssl.getSSLParameters();
            parameters.setServerNames(List.of(new SNIHostName(dnsName)));
            ssl.setSSLParameters(parameters);
            return ssl;
        }

        @Override public String[] getDefaultCipherSuites() { return delegate.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return delegate.getSupportedCipherSuites(); }
        @Override public java.net.Socket createSocket() throws IOException { return configure(delegate.createSocket()); }
        @Override public java.net.Socket createSocket(java.net.Socket s, String h, int p, boolean a) throws IOException { return configure(delegate.createSocket(s, h, p, a)); }
        @Override public java.net.Socket createSocket(String h, int p) throws IOException { return configure(delegate.createSocket(h, p)); }
        @Override public java.net.Socket createSocket(String h, int p, java.net.InetAddress l, int lp) throws IOException { return configure(delegate.createSocket(h, p, l, lp)); }
        @Override public java.net.Socket createSocket(java.net.InetAddress h, int p) throws IOException { return configure(delegate.createSocket(h, p)); }
        @Override public java.net.Socket createSocket(java.net.InetAddress h, int p, java.net.InetAddress l, int lp) throws IOException { return configure(delegate.createSocket(h, p, l, lp)); }
    }
}
