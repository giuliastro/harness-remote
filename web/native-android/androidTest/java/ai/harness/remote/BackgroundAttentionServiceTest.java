package ai.harness.remote;

import android.app.Activity;
import android.app.Instrumentation.ActivityMonitor;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import android.service.notification.StatusBarNotification;
import android.webkit.WebStorage;

import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

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
        BackgroundAttentionVisibility.setForeground(false);
        BackgroundAttentionVisibility.clear();
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
        BackgroundAttentionVisibility.setForeground(false);
        BackgroundAttentionVisibility.clear();
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

    @Test
    public void notifiesPermissionAndQuestionOnceWithExactContext() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);

        server.sendEvent(permissionAsked("perm-1"));
        String permissionTitle = context.getString(R.string.hr_attention_permission_title);
        waitFor("permission notification", () -> attentionNotification(permissionTitle) != null, 5_000);
        Notification permission = attentionNotification(permissionTitle);
        assertNotNull(permission);
        assertNotNull("the notification must carry an exact Session PendingIntent", permission.contentIntent);
        String permissionBody = notificationBody(permission);
        assertTrue(permissionBody.contains("bash"));
        assertTrue(permissionBody.contains("Needs to edit files"));
        assertTrue(permissionBody.contains(context.getString(R.string.hr_attention_boundary, "src/**")));
        assertTrue(permissionBody.contains(context.getString(R.string.hr_attention_permission_consequence)));
        assertTrue(permissionBody.contains("Test Machine · OpenCode"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            assertEquals(AttentionNotificationCenter.ATTENTION_CHANNEL_ID, permission.getChannelId());
        }

        server.sendEvent(permissionAsked("perm-1"));
        Thread.sleep(750);
        assertEquals("a repeated frame must not duplicate the request", 1, attentionNotificationCount(permissionTitle));

        server.sendEvent(questionAsked("q-1"));
        String questionTitle = context.getString(R.string.hr_attention_question_title);
        waitFor("question notification", () -> attentionNotification(questionTitle) != null, 5_000);
        Notification question = attentionNotification(questionTitle);
        assertNotNull(question);
        String questionBody = notificationBody(question);
        assertTrue(questionBody.contains("Which branch?"));
        assertTrue(questionBody.contains(context.getString(R.string.hr_attention_question_consequence)));
        assertTrue(questionBody.contains("Test Machine · OpenCode"));
    }

    @Test
    public void notificationOpensTheExactAttentionDeepLink() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String permissionTitle = context.getString(R.string.hr_attention_permission_title);
        String asked = permissionAsked("perm-link");
        server.sendEvent(asked);
        waitFor("permission notification", () -> attentionNotification(permissionTitle) != null, 5_000);
        Notification notification = attentionNotification(permissionTitle);
        assertNotNull(notification);
        assertNotNull(notification.contentIntent);
        // Android 14 rejects an instrumentation-initiated background activity launch even when the
        // PendingIntent is the one from the notification. API 35 exercises the actual launch; the
        // real notification path was also verified on the phone.
        Assume.assumeTrue("Android 14 blocks instrumentation background activity launch", Build.VERSION.SDK_INT >= 35);

        IntentFilter filter = new IntentFilter(Intent.ACTION_VIEW);
        filter.addCategory(Intent.CATEGORY_DEFAULT);
        filter.addDataScheme("harnessremote");
        filter.addDataAuthority("attention", null);
        ActivityMonitor monitor = InstrumentationRegistry.getInstrumentation().addMonitor(filter, null, false);
        try {
            notification.contentIntent.send();
            Activity activity = monitor.waitForActivityWithTimeout(5_000);
            assertNotNull("the notification must open MainActivity", activity);
            Uri data = activity.getIntent().getData();
            assertNotNull(data);
            assertEquals("harnessremote", data.getScheme());
            assertEquals("attention", data.getHost());
            assertEquals(FakeMachineServer.MACHINE_ID, data.getQueryParameter("machineID"));
            assertEquals(FakeMachineServer.AGENT_ID, data.getQueryParameter("agentID"));
            assertEquals("session-1", data.getQueryParameter("sessionID"));
            InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        } finally {
            InstrumentationRegistry.getInstrumentation().removeMonitor(monitor);
        }
    }

    @Test
    public void cancelsPermissionNotificationWhenTheHarnessResolvesIt() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String permissionTitle = context.getString(R.string.hr_attention_permission_title);
        server.sendEvent(permissionAsked("perm-2"));
        waitFor("permission notification", () -> attentionNotification(permissionTitle) != null, 5_000);

        server.sendEvent(permissionReplied("perm-2"));
        waitFor("permission notification cleared", () -> attentionNotificationCount(permissionTitle) == 0, 5_000);
    }

    @Test
    public void notifiesReadyAndFailedSessionOutcomesOnce() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String readyTitle = context.getString(R.string.hr_outcome_ready_title);
        String failedTitle = context.getString(R.string.hr_outcome_failed_title);

        server.sendEvent(sessionStatus("outcome-1", "busy"));
        server.sendEvent(sessionIdle("outcome-1"));
        waitFor("ready notification", () -> attentionNotification(readyTitle) != null, 5_000);
        Notification ready = attentionNotification(readyTitle);
        assertNotNull(ready);
        assertTrue(notificationBody(ready).contains("Test Machine · OpenCode"));

        server.sendEvent(sessionIdle("outcome-1"));
        Thread.sleep(600);
        assertEquals("repeated idle must not duplicate Ready", 1, attentionNotificationCount(readyTitle));

        server.sendEvent(sessionError("outcome-1", "Provider failed"));
        waitFor("failed notification", () -> attentionNotification(failedTitle) != null, 5_000);
        Notification failed = attentionNotification(failedTitle);
        assertNotNull(failed);
        assertTrue(notificationBody(failed).contains("Provider failed"));
        waitFor("ready notification replaced", () -> attentionNotificationCount(readyTitle) == 0, 5_000);

        server.sendEvent(sessionStatus("outcome-1", "busy"));
        waitFor("failed notification cleared on a new turn", () -> attentionNotificationCount(failedTitle) == 0, 5_000);
    }

    @Test
    public void doesNotReadyNotifyWhilePermissionIsPending() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String permissionTitle = context.getString(R.string.hr_attention_permission_title);
        server.sendEvent(permissionAsked("perm-outcome"));
        waitFor("permission notification", () -> attentionNotification(permissionTitle) != null, 5_000);

        server.sendEvent(sessionStatus("session-1", "busy"));
        server.sendEvent(sessionIdle("session-1"));
        Thread.sleep(700);
        assertEquals(0, attentionNotificationCount(context.getString(R.string.hr_outcome_ready_title)));
    }

    @Test
    public void suppressesReadyForTheVisibleSessionAndResumesWhenBackgrounded() throws Exception {
        BackgroundAttentionVisibility.setVisibleSession(
            FakeMachineServer.MACHINE_ID,
            FakeMachineServer.AGENT_ID,
            "outcome-visible"
        );
        BackgroundAttentionVisibility.setForeground(true);
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String readyTitle = context.getString(R.string.hr_outcome_ready_title);

        server.sendEvent(sessionStatus("outcome-visible", "busy"));
        server.sendEvent(sessionIdle("outcome-visible"));
        Thread.sleep(700);
        assertEquals("a visible Session must not duplicate its Ready state as a notification", 0, attentionNotificationCount(readyTitle));

        BackgroundAttentionVisibility.setForeground(false);
        server.sendEvent(sessionStatus("outcome-visible", "busy"));
        server.sendEvent(sessionIdle("outcome-visible"));
        waitFor("ready after background", () -> attentionNotification(readyTitle) != null, 5_000);
    }

    @Test
    public void clearsReadyWhenItsSessionBecomesVisible() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String readyTitle = context.getString(R.string.hr_outcome_ready_title);
        server.sendEvent(sessionStatus("outcome-visible", "busy"));
        server.sendEvent(sessionIdle("outcome-visible"));
        waitFor("ready notification", () -> attentionNotification(readyTitle) != null, 5_000);

        BackgroundAttentionVisibility.setVisibleSession(
            FakeMachineServer.MACHINE_ID,
            FakeMachineServer.AGENT_ID,
            "outcome-visible"
        );
        BackgroundAttentionVisibility.setForeground(true);
        context.startService(new Intent(context, BackgroundAttentionService.class)
            .setAction(BackgroundAttentionService.ACTION_VISIBILITY)
            .putExtra(BackgroundAttentionService.EXTRA_VISIBLE_MACHINE, FakeMachineServer.MACHINE_ID)
            .putExtra(BackgroundAttentionService.EXTRA_VISIBLE_AGENT, FakeMachineServer.AGENT_ID)
            .putExtra(BackgroundAttentionService.EXTRA_VISIBLE_SESSION, "outcome-visible"));
        waitFor("ready notification cleared", () -> attentionNotificationCount(readyTitle) == 0, 5_000);
    }

    @Test
    public void repliesToPermissionExactlyOnceFromNotificationActions() throws Exception {
        startService();
        waitFor("machine connected", () -> BackgroundAttentionStatus.isMachineConnected(FakeMachineServer.MACHINE_ID), 15_000);
        String permissionTitle = context.getString(R.string.hr_attention_permission_title);
        server.sendEvent(permissionAsked("perm-actions"));
        waitFor("permission notification", () -> attentionNotification(permissionTitle) != null, 5_000);
        Notification notification = attentionNotification(permissionTitle);
        assertNotNull(notification);
        assertNotNull(notification.actions);
        assertEquals(2, notification.actions.length);

        Notification.Action allow = notificationAction(notification, context.getString(R.string.hr_attention_allow_once));
        Notification.Action deny = notificationAction(notification, context.getString(R.string.hr_attention_deny));
        assertNotNull(allow);
        assertNotNull(deny);

        allow.actionIntent.send();
        assertEquals("{\"reply\":\"once\"}", server.permissionReplies.poll(5, TimeUnit.SECONDS));
        waitFor("permission notification cleared after allow", () -> attentionNotificationCount(permissionTitle) == 0, 5_000);

        allow.actionIntent.send();
        assertNull("a repeated action must not reply twice", server.permissionReplies.poll(500, TimeUnit.MILLISECONDS));

        server.sendEvent(permissionAsked("perm-deny"));
        waitFor("second permission notification", () -> attentionNotification(permissionTitle) != null, 5_000);
        Notification second = attentionNotification(permissionTitle);
        assertNotNull(second);
        Notification.Action reject = notificationAction(second, context.getString(R.string.hr_attention_deny));
        assertNotNull(reject);
        reject.actionIntent.send();
        assertEquals("{\"reply\":\"reject\"}", server.permissionReplies.poll(5, TimeUnit.SECONDS));
        waitFor("permission notification cleared after deny", () -> attentionNotificationCount(permissionTitle) == 0, 5_000);
    }

    private static Notification.Action notificationAction(Notification notification, String title) {
        if (notification.actions == null) return null;
        for (Notification.Action action : notification.actions) {
            if (action.title != null && title.contentEquals(action.title)) return action;
        }
        return null;
    }

    private static String permissionAsked(String id) {
        return "{\"directory\":\"/tmp\",\"payload\":{\"type\":\"permission.asked\",\"properties\":{"
            + "\"sessionID\":\"session-1\",\"id\":\"" + id + "\",\"permission\":\"bash\","
            + "\"patterns\":[\"src/**\"],\"metadata\":{\"reason\":\"Needs to edit files\"}}}}";
    }

    private static String questionAsked(String id) {
        return "{\"directory\":\"/tmp\",\"payload\":{\"type\":\"question.asked\",\"properties\":{"
            + "\"sessionID\":\"session-1\",\"id\":\"" + id + "\","
            + "\"questions\":[{\"question\":\"Which branch?\",\"header\":\"Branch\"}]}}}";
    }

    private static String permissionReplied(String id) {
        return "{\"directory\":\"/tmp\",\"payload\":{\"type\":\"permission.replied\",\"properties\":{"
            + "\"sessionID\":\"session-1\",\"id\":\"" + id + "\"}}}";
    }

    private static String sessionStatus(String sessionID, String status) {
        return "{\"payload\":{\"type\":\"session.status\",\"properties\":{\"sessionID\":\""
            + sessionID + "\",\"status\":{\"type\":\"" + status + "\"}}}}";
    }

    private static String sessionIdle(String sessionID) {
        return "{\"payload\":{\"type\":\"session.idle\",\"properties\":{\"sessionID\":\""
            + sessionID + "\"}}}";
    }

    private static String sessionError(String sessionID, String message) {
        return "{\"payload\":{\"type\":\"session.error\",\"properties\":{\"sessionID\":\""
            + sessionID + "\",\"error\":{\"message\":\"" + message + "\"}}}}";
    }

    private Notification attentionNotification(String title) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return null;
        for (StatusBarNotification status : manager.getActiveNotifications()) {
            Notification notification = status.getNotification();
            CharSequence actual = notification.extras.getCharSequence(Notification.EXTRA_TITLE);
            if (actual != null && title.contentEquals(actual)) return notification;
        }
        return null;
    }

    private int attentionNotificationCount(String title) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return 0;
        int count = 0;
        for (StatusBarNotification status : manager.getActiveNotifications()) {
            CharSequence actual = status.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE);
            if (actual != null && title.contentEquals(actual)) count += 1;
        }
        return count;
    }

    private static String notificationBody(Notification notification) {
        CharSequence big = notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        CharSequence text = big != null ? big : notification.extras.getCharSequence(Notification.EXTRA_TEXT);
        return text == null ? "" : text.toString();
    }

    @Test
    public void stopsTheForegroundServiceFromItsNotificationAction() throws Exception {
        startService();
        waitFor("foreground notification", () -> serviceNotification() != null, 5_000);
        Notification notification = serviceNotification();
        assertNotNull(notification);
        assertNotNull(notification.actions);
        assertEquals(1, notification.actions.length);
        assertEquals(context.getString(R.string.hr_bg_stop), String.valueOf(notification.actions[0].title));

        notification.actions[0].actionIntent.send();
        waitFor("service stopped", () -> !BackgroundAttentionStatus.running, 5_000);
        waitFor("foreground notification removed", () -> serviceNotification() == null, 5_000);
    }

    private Notification serviceNotification() {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return null;
        for (StatusBarNotification status : manager.getActiveNotifications()) {
            if (status.getId() == BackgroundAttentionNotifications.SERVICE_NOTIFICATION_ID) {
                return status.getNotification();
            }
        }
        return null;
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
        // The notification PendingIntent is the production trigger; the instrumentation process
        // sends it directly, so Android 14 needs the app's background-activity app-op to behave like
        // a real notification tap rather than rejecting the test's launch.
        shell("cmd appops set " + context.getPackageName() + " START_ACTIVITIES_FROM_BACKGROUND allow");
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
