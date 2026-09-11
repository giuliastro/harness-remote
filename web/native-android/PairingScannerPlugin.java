package ai.harness.remote;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

@CapacitorPlugin(name = "PairingScanner")
public class PairingScannerPlugin extends Plugin {
    @PluginMethod
    public void scan(PluginCall call) {
        if (getActivity() == null) {
            call.reject("QR scanner is unavailable because the Android activity is not ready");
            return;
        }

        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);

        getActivity().runOnUiThread(() -> scanner.startScan()
            .addOnSuccessListener(barcode -> {
                String value = barcode.getRawValue();
                if (value == null || value.trim().isEmpty()) {
                    call.reject("The scanned QR code did not contain a value");
                    return;
                }
                JSObject result = new JSObject();
                result.put("value", value);
                call.resolve(result);
            })
            .addOnCanceledListener(() -> {
                JSObject result = new JSObject();
                result.put("cancelled", true);
                call.resolve(result);
            })
            .addOnFailureListener(error -> call.reject(
                error.getMessage() != null ? error.getMessage() : "QR scanner failed",
                error
            ))
        );
    }
}
