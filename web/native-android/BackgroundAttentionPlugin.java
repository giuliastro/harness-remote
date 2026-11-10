package ai.harness.remote;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

@CapacitorPlugin(name = "BackgroundAttention")
public class BackgroundAttentionPlugin extends Plugin {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7413;

    private PluginCall pendingPermissionCall;

    @PluginMethod
    public void configure(PluginCall call) {
        JSArray machines = call.getArray("machines");
        List<BackgroundAttentionConfig.Machine> parsed =
            BackgroundAttentionConfig.parse(machines == null ? "[]" : machines.toString());
        if (parsed == null) {
            call.reject("The background machines payload is invalid");
            return;
        }
        BackgroundAttentionConfig.save(getContext(), parsed);
        if (BackgroundAttentionStatus.running) {
            Intent intent = new Intent(getContext(), BackgroundAttentionService.class)
                .setAction(BackgroundAttentionService.ACTION_CONFIGURE)
                .putExtra(BackgroundAttentionService.EXTRA_MACHINES, BackgroundAttentionConfig.serialize(parsed));
            try {
                getContext().startService(intent);
            } catch (Exception error) {
                call.reject("The background service configuration could not be applied", error);
                return;
            }
        }
        call.resolve(statusObject());
    }

    @PluginMethod
    public void start(PluginCall call) {
        boolean prompt = Boolean.TRUE.equals(call.getBoolean("prompt", false));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationPermission()) {
            if (!prompt || getActivity() == null) {
                call.resolve(statusObject());
                return;
            }
            pendingPermissionCall = call;
            getActivity().requestPermissions(
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                NOTIFICATION_PERMISSION_REQUEST
            );
            return;
        }
        maybePromptBatteryExemption(prompt);
        startService(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), BackgroundAttentionService.class));
        call.resolve(statusObject());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return;
        PluginCall call = pendingPermissionCall;
        pendingPermissionCall = null;
        if (call == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            call.resolve(statusObject());
            return;
        }
        maybePromptBatteryExemption(true);
        startService(call);
    }

    @Override
    protected void handleOnDestroy() {
        PluginCall call = pendingPermissionCall;
        pendingPermissionCall = null;
        if (call != null) call.resolve(statusObject());
    }

    private void startService(PluginCall call) {        Context context = getContext();
        Intent intent = new Intent(context, BackgroundAttentionService.class)
            .setAction(BackgroundAttentionService.ACTION_START);
        try {
            if (BackgroundAttentionStatus.running) context.startService(intent);
            else ContextCompat.startForegroundService(context, intent);
            call.resolve(statusObject());
        } catch (Exception error) {
            call.reject("The background connection could not start", error);
        }
    }

    private void maybePromptBatteryExemption(boolean prompt) {
        if (!prompt || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        Context context = getContext();
        if (batteryExempt() || BackgroundAttentionConfig.batteryPrompted(context)) return;
        Activity activity = getActivity();
        if (activity == null) return;
        BackgroundAttentionConfig.setBatteryPrompted(context, true);
        try {
            activity.startActivity(new Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.getPackageName())
            ));
        } catch (Exception ignored) {
            // The direct dialog is not available on every OEM build. Never send the user hunting
            // through Settings as a fallback; the next slice can show the device-specific guidance.
        }
    }

    private boolean notificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean batteryExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager manager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private JSObject statusObject() {
        JSObject result = new JSObject();
        result.put("supported", true);
        result.put("running", BackgroundAttentionStatus.running);
        result.put("configuredMachines", BackgroundAttentionStatus.configuredMachines);
        result.put("connectedMachines", BackgroundAttentionStatus.connectedMachines());
        result.put("notificationPermission", notificationPermission());
        result.put("batteryExempt", batteryExempt());
        result.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        result.put("lastError", BackgroundAttentionStatus.lastError == null ? "" : BackgroundAttentionStatus.lastError);
        return result;
    }
}
