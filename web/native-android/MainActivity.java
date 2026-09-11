package ai.harness.remote;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(LiveEventsPlugin.class);
        registerPlugin(PairingScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
