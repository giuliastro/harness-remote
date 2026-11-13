package ai.harness.remote;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/** E1 device identity. The private key never leaves Android Keystore. */
@CapacitorPlugin(name = "DeviceKey")
public final class DeviceKeyPlugin extends Plugin {
    private static final String ALIAS = "harness_remote_device_p256_v1";
    private static final int BASE64_FLAGS = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;

    private static synchronized KeyPair keyPair() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build());
            generator.generateKeyPair();
        }
        KeyStore.PrivateKeyEntry entry = (KeyStore.PrivateKeyEntry) store.getEntry(ALIAS, null);
        if (entry == null) throw new IllegalStateException("Device identity is unavailable");
        PrivateKey privateKey = entry.getPrivateKey();
        PublicKey publicKey = entry.getCertificate().getPublicKey();
        return new KeyPair(publicKey, privateKey);
    }

    @PluginMethod
    public void publicKey(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("publicKey", Base64.encodeToString(keyPair().getPublic().getEncoded(), BASE64_FLAGS));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Cannot load the device key", error);
        }
    }

    @PluginMethod
    public void sign(PluginCall call) {
        String message = call.getString("message");
        // The eventual authenticated transport signs its complete framed transcript. Keep this
        // primitive bounded so a malformed native bridge call cannot sign arbitrary large input.
        if (message == null || message.length() > 8192) {
            call.reject("Invalid signing message");
            return;
        }
        try {
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(keyPair().getPrivate());
            signer.update(message.getBytes(StandardCharsets.UTF_8));
            JSObject result = new JSObject();
            result.put("signature", Base64.encodeToString(signer.sign(), BASE64_FLAGS));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Cannot sign with the device key", error);
        }
    }
}
