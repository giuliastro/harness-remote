package ai.harness.remote;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import android.service.notification.StatusBarNotification;
import android.webkit.WebStorage;

import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
public class BackgroundAttentionServiceTest {
    private Context context;
    private FakeMachineServer server;

    @Before
    public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        // A previous run may have left a WebView machine list behind. The Doze test starts from a
        // clean shell so its one-time empty handoff is deterministic, as it is on a fresh install.
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> WebStorage.getInstance().deleteAllData());
        grantNotificationPermission();
        server = new FakeMachineServer();
        server.start();
        BackgroundAttentionConfig.save(context, Collections.singletonList(machine()));
        BackgroundAttentionConfig.setBatteryPrompted(context, true);
        BackgroundAttentionStatus.reset();
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        assertNotNull(powerManager);
        assertTrue(
            "the emulator battery exemption must be effective before the Doze assertion",
            powerManager.isIgnoringBatteryOptimizations(context.getPackageName())
        );
    }

    @After
    public void tearDown() throws Exception {
        context.stopService(new Intent(context, BackgroundAttentionService.class));
        server.close();
        forceIdle(false);
        waitFor("service stopped", () -> !BackgroundAttentionStatus.running, 5_000);
    }

    @Test
    public void keepsTheStreamAndNotificationAliveWithTheActivityDestroyedAndTheDeviceIdle() throws Exception {
        Activity activity = InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        );
        // The web shell writes its own (empty) paired-machine snapshot on first mount. Let that
        // one-time handoff finish before destroying the activity, then install the test machine and
        // start the service with no WebView left to reconcile against it.
        waitFor("web shell initial handoff", () -> BackgroundAttentionConfig.load(context).isEmpty(), 10_000);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        waitFor("activity destroyed", activity::isDestroyed, 5_000);
        BackgroundAttentionConfig.save(context, Collections.singletonList(machine()));

        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);

        String expected = context.getResources().getQuantityString(R.plurals.hr_bg_connected_machines, 1, 1);
        waitFor("foreground notification", () -> expected.equals(notificationText()), 5_000);

        assertTrue("the foreground service must survive activity destruction", BackgroundAttentionStatus.running);

        long before = BackgroundAttentionStatus.lastFrameAt(FakeMachineServer.MACHINE_ID);
        forceIdle(true);
        long deadline = System.currentTimeMillis() + 30_000;
        boolean alive = false;
        while (System.currentTimeMillis() < deadline) {
            if (BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID)
                && BackgroundAttentionStatus.lastFrameAt(FakeMachineServer.MACHINE_ID) > before) {
                alive = true;
                break;
            }
            Thread.sleep(250);
        }
        assertTrue(
            "the foreground service must keep reading its stream in Doze (running="
                + BackgroundAttentionStatus.running
                + ", connected=" + BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID)
                + ", lastError=" + BackgroundAttentionStatus.lastError + ")",
            alive
        );
        waitFor("notification connected in Doze", () -> expected.equals(notificationText()), 5_000);
        assertEquals(expected, notificationText());
    }

    @Test
    public void reconnectsAfterTheStreamDrops() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        int connectionsBefore = server.streamConnections;
        server.dropStreams();
        waitFor(
            "stream reconnected",
            () -> server.streamConnections > connectionsBefore
                && BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID),
            20_000
        );
    }

    @Test
    public void acceptsOnlyAValidatedMachineConfiguration() {
        String json = "[{\"id\":\"m1\",\"name\":\"One\",\"baseUrl\":\"http://127.0.0.1:4097\","
            + "\"username\":\"u\",\"password\":\"p\"},"
            + "{\"id\":\"bad\",\"name\":\"Bad\",\"baseUrl\":\"ftp://127.0.0.1:4097\","
            + "\"username\":\"u\",\"password\":\"p\"}]";
        List<BackgroundAttentionConfig.Machine> parsed = BackgroundAttentionConfig.parse(json);
        assertNotNull(parsed);
        assertEquals(1, parsed.size());
        assertEquals("m1", parsed.get(0).id);
        assertNull(BackgroundAttentionConfig.parse("not json"));
    }

    private void startService() {
        ContextCompat.startForegroundService(
            context,
            new Intent(context, BackgroundAttentionService.class)
                .setAction(BackgroundAttentionService.ACTION_START)
        );
    }

    private BackgroundAttentionConfig.Machine machine() {
        return new BackgroundAttentionConfig.Machine(
            FakeMachineServer.MACHINE_ID,
            "Test Machine",
            server.baseUrl(),
            "harness",
            "secret"
        );
    }

    private String notificationText() {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return null;
        StatusBarNotification[] active = manager.getActiveNotifications();
        for (StatusBarNotification status : active) {
            if (status.getId() != BackgroundAttentionNotifications.SERVICE_NOTIFICATION_ID) continue;
            Notification notification = status.getNotification();
            CharSequence text = notification.extras.getCharSequence(Notification.EXTRA_TEXT);
            return text == null ? null : text.toString();
        }
        return null;
    }

    private void grantNotificationPermission() throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        shell("pm grant " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        shell("dumpsys deviceidle whitelist +" + context.getPackageName());
    }

    private void forceIdle(boolean idle) throws Exception {
        if (!idle) {
            shell("dumpsys deviceidle unforce");
            return;
        }
        shell("dumpsys deviceidle enable deep");
        shell("dumpsys deviceidle force-idle deep");
        waitFor("deep idle", () -> "IDLE".equals(shellOutput("dumpsys deviceidle get deep").trim()), 10_000);
    }

    private void shell(String command) throws Exception {
        shellOutput(command);
    }

    private String shellOutput(String command) throws Exception {
        UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            byte[] buffer = new byte[1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private void waitFor(String description, Condition condition, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (condition.get()) return;
            Thread.sleep(100);
        }
        throw new AssertionError("Timed out waiting for " + description);
    }

    private interface Condition {
        boolean get() throws Exception;
    }
}
