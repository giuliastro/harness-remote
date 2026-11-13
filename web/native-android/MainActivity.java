package ai.harness.remote;

import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(BackgroundAttentionPlugin.class);
        registerPlugin(LiveEventsPlugin.class);
        registerPlugin(PairingScannerPlugin.class);
        registerPlugin(DeviceKeyPlugin.class);
        registerPlugin(RemoteMachinePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                /**
                 * Android may kill the WebView renderer while the app sits in the background. Left
                 * unhandled, the app process is killed and the next notification tap can show an
                 * empty page. Rebuild this activity instead, so only that case reloads the app;
                 * an ordinary notification tap keeps the running app as it is.
                 */
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    Log.w("HarnessRemote", "WebView renderer gone; recreating the activity");
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed()) recreate();
                    });
                    return true;
                }
            });
        }
    }
}
