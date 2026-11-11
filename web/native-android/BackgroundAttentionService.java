package ai.harness.remote;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Keeps the paired machines' capability-scoped live streams open while the WebView is gone.
 *
 * This is the piece #404 lacked: the previous prototype produced notifications from a WebView plugin,
 * so Android suspended the only process that could deliver them. This service owns the sockets, posts
 * the required low-priority foreground notification, and never mutates a native Session. It only
 * reads the same authenticated event stream the app already uses.
 */
public final class BackgroundAttentionService extends Service {
    static final String ACTION_START = "ai.harness.remote.action.START_BACKGROUND_ATTENTION";
    static final String ACTION_CONFIGURE = "ai.harness.remote.action.CONFIGURE_BACKGROUND_ATTENTION";
    static final String ACTION_STOP = "ai.harness.remote.action.STOP_BACKGROUND_ATTENTION";
    static final String ACTION_SHOW_NOTIFICATION = "ai.harness.remote.action.SHOW_BACKGROUND_ATTENTION_NOTIFICATION";
    static final String ACTION_VISIBILITY = "ai.harness.remote.action.VISIBLE_ATTENTION_SESSION";
    static final String ACTION_PERMISSION_REPLY = "ai.harness.remote.action.PERMISSION_REPLY";
    static final String EXTRA_MACHINES = "machines";
    static final String EXTRA_VISIBLE_MACHINE = "visibleMachine";
    static final String EXTRA_VISIBLE_AGENT = "visibleAgent";
    static final String EXTRA_VISIBLE_SESSION = "visibleSession";
    static final String EXTRA_PERMISSION_MACHINE = "permissionMachine";
    static final String EXTRA_PERMISSION_AGENT = "permissionAgent";
    static final String EXTRA_PERMISSION_SESSION = "permissionSession";
    static final String EXTRA_PERMISSION_REQUEST = "permissionRequest";
    static final String EXTRA_PERMISSION_DIRECTORY = "permissionDirectory";
    static final String EXTRA_PERMISSION_REPLY = "permissionReply";

    private static final String TAG = "HarnessBackground";
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    // The daemon sends an SSE heartbeat every 10 seconds; 35 seconds without a byte means the socket
    // is stale after sleep, a Wi-Fi handoff or a short network loss.
    private static final int READ_TIMEOUT_MS = 35_000;
    private static final long SNAPSHOT_REFRESH_MS = 60_000;

    private final Object runtimeLock = new Object();
    private final Map<String, MachineRuntime> runtimes = new LinkedHashMap<>();
    private ExecutorService executor;
    private Handler mainHandler;
    private ConnectivityManager.NetworkCallback networkCallback;
    private AttentionNotificationCenter attentionNotifications;
    private SessionOutcomeCenter sessionOutcomes;
    private MachineAlertCenter machineAlerts;
    private final PermissionReplyTracker permissionReplies = new PermissionReplyTracker();
    private volatile boolean shuttingDown;
    private int lastNotificationConnected = -1;
    private int lastNotificationConfigured = -1;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "service create");
        shuttingDown = false;
        mainHandler = new Handler(Looper.getMainLooper());
        BackgroundAttentionStatus.reset();
        BackgroundAttentionStatus.running = true;
        BackgroundAttentionNotifications.ensureChannels(this);
        attentionNotifications = new AttentionNotificationCenter(this);
        sessionOutcomes = new SessionOutcomeCenter(this, attentionNotifications);
        machineAlerts = new MachineAlertCenter(this);
        int configured = BackgroundAttentionConfig.load(this).size();
        startInForeground(0, configured);
        executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "hr-background-attention");
            thread.setDaemon(true);
            return thread;
        });
        registerNetworkCallback();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        Log.i(TAG, "service start action=" + action);
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_SHOW_NOTIFICATION.equals(action)) {
            // HyperOS can hide the ongoing notification while the service stays alive. Re-post it
            // explicitly instead of waiting for a connection-count change to update it.
            if (BackgroundAttentionStatus.running) {
                startInForeground(
                    BackgroundAttentionStatus.connectedMachines(),
                    BackgroundAttentionStatus.configuredMachines
                );
            }
            return START_STICKY;
        }
        if (ACTION_VISIBILITY.equals(action)) {
            if (sessionOutcomes != null) {
                sessionOutcomes.onVisibilityChanged(
                    intent.getStringExtra(EXTRA_VISIBLE_MACHINE),
                    intent.getStringExtra(EXTRA_VISIBLE_AGENT),
                    intent.getStringExtra(EXTRA_VISIBLE_SESSION)
                );
            }
            return START_STICKY;
        }
        if (ACTION_PERMISSION_REPLY.equals(action)) {
            handlePermissionReply(intent);
            return START_STICKY;
        }

        if (ACTION_CONFIGURE.equals(action) && intent.hasExtra(EXTRA_MACHINES)) {
            List<BackgroundAttentionConfig.Machine> parsed =
                BackgroundAttentionConfig.parse(intent.getStringExtra(EXTRA_MACHINES));
            if (parsed == null) {
                BackgroundAttentionStatus.setLastError("Invalid background machine configuration");
            } else {
                BackgroundAttentionConfig.save(this, parsed);
            }
        }

        List<BackgroundAttentionConfig.Machine> machines = BackgroundAttentionConfig.load(this);
        if (machines.isEmpty()) {
            Log.i(TAG, "service stopping: no configured machines");
            stopSelf();
            return START_NOT_STICKY;
        }
        Log.i(TAG, "service machines=" + machines.size());
        applyMachines(machines);
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "service task removed");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "service destroy");
        shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startInForeground(int connected, int configured) {
        Notification notification = BackgroundAttentionNotifications.buildServiceNotification(this, connected, configured);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    BackgroundAttentionNotifications.SERVICE_NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                );
            } else {
                startForeground(BackgroundAttentionNotifications.SERVICE_NOTIFICATION_ID, notification);
            }
            lastNotificationConnected = connected;
            lastNotificationConfigured = configured;
        } catch (Exception error) {
            Log.w(TAG, "foreground notification could not start");
            stopSelf();
        }
    }

    private void applyMachines(List<BackgroundAttentionConfig.Machine> machines) {
        synchronized (runtimeLock) {
            Set<String> desired = new HashSet<>();
            for (BackgroundAttentionConfig.Machine machine : machines) desired.add(machine.id);

            for (String id : new ArrayList<>(runtimes.keySet())) {
                if (desired.contains(id)) continue;
                MachineRuntime removed = runtimes.remove(id);
                if (removed != null) removed.stop();
            }

            for (BackgroundAttentionConfig.Machine machine : machines) {
                MachineRuntime current = runtimes.get(machine.id);
                if (current != null && !current.machine.sameConnection(machine)) {
                    current.stop();
                    runtimes.remove(machine.id);
                    current = null;
                }
                if (current == null) {
                    MachineRuntime created = new MachineRuntime(machine);
                    runtimes.put(machine.id, created);
                    created.start();
                }
            }
            BackgroundAttentionStatus.configuredMachines = machines.size();
        }
        updateNotificationSoon();
    }

    private void wakeAll() {
        List<MachineRuntime> snapshot;
        synchronized (runtimeLock) {
            snapshot = new ArrayList<>(runtimes.values());
        }
        for (MachineRuntime runtime : snapshot) runtime.wake();
    }

    private void registerNetworkCallback() {
        try {
            ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (manager == null) return;
            NetworkRequest request = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    wakeAll();
                }
            };
            manager.registerNetworkCallback(request, networkCallback);
        } catch (Exception error) {
            Log.w(TAG, "network callback could not be registered");
        }
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        try {
            ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (manager != null) manager.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) {
            // The process may be going away; nothing to recover here.
        }
        networkCallback = null;
    }

    private void updateNotificationSoon() {
        Handler handler = mainHandler;
        if (handler == null || shuttingDown) return;
        handler.post(this::updateNotification);
    }

    private void updateNotification() {
        if (shuttingDown) return;
        int connected = BackgroundAttentionStatus.connectedMachines();
        int configured = BackgroundAttentionStatus.configuredMachines;
        if (connected == lastNotificationConnected && configured == lastNotificationConfigured) return;
        lastNotificationConnected = connected;
        lastNotificationConfigured = configured;
        Notification notification = BackgroundAttentionNotifications.buildServiceNotification(this, connected, configured);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(BackgroundAttentionNotifications.SERVICE_NOTIFICATION_ID, notification);
    }

    private void shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        BackgroundAttentionStatus.running = false;
        unregisterNetworkCallback();
        List<MachineRuntime> snapshot;
        synchronized (runtimeLock) {
            snapshot = new ArrayList<>(runtimes.values());
            runtimes.clear();
        }
        for (MachineRuntime runtime : snapshot) runtime.stop();
        if (executor != null) executor.shutdownNow();
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(BackgroundAttentionNotifications.SERVICE_NOTIFICATION_ID);
        if (attentionNotifications != null) attentionNotifications.cancelAll();
        if (sessionOutcomes != null) sessionOutcomes.cancelAll();
        if (machineAlerts != null) machineAlerts.clearAll();
        permissionReplies.clear();
        BackgroundAttentionStatus.clearConnections();
    }

    private void handlePermissionReply(Intent intent) {
        if (intent == null) return;
        String machineID = intent.getStringExtra(EXTRA_PERMISSION_MACHINE);
        String agentID = intent.getStringExtra(EXTRA_PERMISSION_AGENT);
        String sessionID = intent.getStringExtra(EXTRA_PERMISSION_SESSION);
        String requestID = intent.getStringExtra(EXTRA_PERMISSION_REQUEST);
        String reply = intent.getStringExtra(EXTRA_PERMISSION_REPLY);
        String directory = intent.getStringExtra(EXTRA_PERMISSION_DIRECTORY);
        if (machineID == null || agentID == null || sessionID == null || requestID == null || requestID.isEmpty()) return;
        if (!"once".equals(reply) && !"reject".equals(reply)) return;
        String key = machineID + "\u0000" + agentID + "\u0000" + requestID;
        if (!permissionReplies.begin(key)) return;
        ExecutorService work = executor;
        if (work == null) {
            permissionReplies.finish(key, false);
            return;
        }
        work.execute(() -> {
            boolean success = false;
            try {
                success = sendPermissionReply(machineID, agentID, requestID, reply, directory);
            } catch (Exception error) {
                BackgroundAttentionStatus.setLastError("Permission reply failed: " + describe(error));
            }
            permissionReplies.finish(key, success);
            if (success && attentionNotifications != null) {
                attentionNotifications.cancelPermission(machineID, agentID, sessionID, requestID);
            }
        });
    }

    private boolean sendPermissionReply(
        String machineID,
        String agentID,
        String requestID,
        String reply,
        String directory
    ) throws IOException {
        BackgroundAttentionConfig.Machine machine = machineForNativeID(machineID);
        if (machine == null) return false;
        StringBuilder target = new StringBuilder(machine.baseUrl)
            .append("/v1/agents/").append(encode(agentID))
            .append("/permission/").append(encode(requestID)).append("/reply");
        if (directory != null && !directory.isEmpty()) {
            target.append("?directory=").append(encode(directory));
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(target.toString()).openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty(
                "Authorization",
                BackgroundAttentionUrls.basicAuthorization(machine.username, machine.password)
            );
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(10_000);
            connection.setDoOutput(true);
            byte[] body = ("{\"reply\":\"" + reply + "\"}").getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            return status == HttpURLConnection.HTTP_OK || status == HttpURLConnection.HTTP_NO_CONTENT;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private BackgroundAttentionConfig.Machine machineForNativeID(String nativeID) {
        synchronized (runtimeLock) {
            for (MachineRuntime runtime : runtimes.values()) {
                if (nativeID.equals(runtime.nativeMachineID)) return runtime.machine;
            }
        }
        return null;
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
    }

    private final class MachineRuntime {
        final BackgroundAttentionConfig.Machine machine;
        final AtomicBoolean stopped = new AtomicBoolean(false);
        final Map<String, AgentStream> streams = new HashMap<>();
        final Object pauseLock = new Object();
        volatile Thread worker;
        volatile boolean snapshotReachable;
        volatile int capableAgents;
        volatile boolean everConnected;
        volatile String nativeMachineID;
        volatile String nativeMachineName;

        MachineRuntime(BackgroundAttentionConfig.Machine machine) {
            this.machine = machine;
            this.nativeMachineID = machine.id;
            this.nativeMachineName = machine.name;
        }

        void start() {
            worker = new Thread(this::run, "hr-machine-" + safeLabel(machine.id));
            worker.setDaemon(true);
            worker.start();
        }

        void stop() {
            stopped.set(true);
            stopAllStreams();
            synchronized (pauseLock) {
                pauseLock.notifyAll();
            }
            Thread active = worker;
            if (active != null) active.interrupt();
            BackgroundAttentionStatus.setMachineConnected(machine.id, false);
        }

        void wake() {
            synchronized (pauseLock) {
                pauseLock.notifyAll();
            }
            List<AgentStream> snapshot;
            synchronized (streams) {
                snapshot = new ArrayList<>(streams.values());
            }
            for (AgentStream stream : snapshot) stream.restart();
        }

        void run() {
            ReconnectBackoff backoff = new ReconnectBackoff(5_000, 60_000);
            while (!stopped.get()) {
                try {
                    List<AgentInfo> agents = loadAgents();
                    snapshotReachable = true;
                    capableAgents = agents.size();
                    reconcile(agents);
                    backoff.reset();
                    BackgroundAttentionStatus.setLastError(null);
                } catch (Exception error) {
                    snapshotReachable = false;
                    capableAgents = 0;
                    stopAllStreams();
                    updateConnected();
                    BackgroundAttentionStatus.setLastError(machine.name + ": " + describe(error));
                }
                pause(snapshotReachable ? SNAPSHOT_REFRESH_MS : backoff.next());
            }
        }

        private List<AgentInfo> loadAgents() throws Exception {
            HttpURLConnection connection = null;
            try {
                connection = openJson(BackgroundAttentionUrls.machineSnapshot(machine.baseUrl));
                int status = connection.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + status);
                String body = readBody(connection.getInputStream(), 1_000_000);
                JSONObject snapshot = new JSONObject(body);
                JSONObject machineInfo = snapshot.optJSONObject("machine");
                if (machineInfo != null) {
                    String nativeID = cleanIdentifier(machineInfo.optString("id", ""));
                    if (!nativeID.isEmpty()) nativeMachineID = nativeID;
                    String nativeName = cleanDisplay(machineInfo.optString("name", ""));
                    if (!nativeName.isEmpty()) nativeMachineName = nativeName;
                }
                JSONArray agents = snapshot.optJSONArray("agents");
                List<AgentInfo> capable = new ArrayList<>();
                if (agents == null) return capable;
                for (int index = 0; index < agents.length() && capable.size() < BackgroundAttentionConfig.MAX_AGENTS_PER_MACHINE; index++) {
                    JSONObject agent = agents.optJSONObject(index);
                    if (agent == null) continue;
                    String id = cleanIdentifier(agent.optString("id", ""));
                    if (id.isEmpty()) continue;
                    String state = agent.optString("state", "").trim().toLowerCase(Locale.US);
                    if (!state.isEmpty() && !"available".equals(state) && !"configured".equals(state)) continue;
                    JSONObject capabilities = agent.optJSONObject("capabilities");
                    if (capabilities == null) continue;
                    // Outcome notifications (finished/failed) matter for every agent. Questions and
                    // permissions only control whether Attention notifications are parsed; an agent
                    // such as Claude Code or Codex has neither capability yet still completes turns.
                    String label = agent.optString("label", id).trim();
                    capable.add(new AgentInfo(
                        id,
                        label.isEmpty() ? id : label,
                        agent.optString("backend", "").trim(),
                        capabilities.optBoolean("questions", false),
                        capabilities.optBoolean("permissions", false)
                    ));
                }
                return capable;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }

        private void reconcile(List<AgentInfo> agents) {
            Set<String> desired = new HashSet<>();
            for (AgentInfo agent : agents) desired.add(agent.id);
            synchronized (streams) {
                for (String id : new ArrayList<>(streams.keySet())) {
                    if (desired.contains(id)) continue;
                    AgentStream removed = streams.remove(id);
                    if (removed != null) removed.stop();
                }
                for (AgentInfo agent : agents) {
                    if (streams.containsKey(agent.id)) continue;
                    AgentStream stream = new AgentStream(agent);
                    streams.put(agent.id, stream);
                    stream.start();
                }
            }
            if (agents.isEmpty()) updateConnected();
        }

        private void stopAllStreams() {
            List<AgentStream> snapshot;
            synchronized (streams) {
                snapshot = new ArrayList<>(streams.values());
                streams.clear();
            }
            for (AgentStream stream : snapshot) stream.stop();
        }

        void updateConnected() {
            List<AgentStream> snapshot;
            synchronized (streams) {
                snapshot = new ArrayList<>(streams.values());
            }
            int active = 0;
            for (AgentStream stream : snapshot) if (stream.connected) active++;
            boolean connected = !stopped.get()
                && (active > 0 || (snapshotReachable && capableAgents == 0));
            BackgroundAttentionStatus.setMachineConnected(machine.id, connected);
            MachineAlertCenter alerts = machineAlerts;
            if (connected) {
                everConnected = true;
                if (alerts != null) alerts.clear(machine.id);
            } else if (everConnected && !stopped.get() && alerts != null) {
                // The stream cannot produce a session.error if the machine itself vanished from
                // Wi-Fi/standby. Surface that loss once and cancel it when any stream reconnects.
                alerts.show(machine.id, machine.name, machine.baseUrl);
            }
            updateNotificationSoon();
        }

        private void pause(long milliseconds) {
            if (stopped.get()) return;
            synchronized (pauseLock) {
                if (stopped.get()) return;
                try {
                    pauseLock.wait(Math.max(1L, milliseconds));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        private HttpURLConnection openJson(String endpoint) throws IOException {
            HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", BackgroundAttentionUrls.basicAuthorization(machine.username, machine.password));
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            return connection;
        }

        private final class AgentStream {
            final AgentInfo agent;
            final AtomicBoolean stopped = new AtomicBoolean(false);
            final Object pauseLock = new Object();
            final AtomicBoolean restartRequested = new AtomicBoolean(false);
            final Set<String> pendingOutcomePolls = new HashSet<>();
            volatile Thread worker;
            volatile HttpURLConnection connection;
            volatile boolean connected;

            AgentStream(AgentInfo agent) {
                this.agent = agent;
            }

            void start() {
                worker = new Thread(this::run, "hr-stream-" + safeLabel(machine.id) + "-" + safeLabel(agent.id));
                worker.setDaemon(true);
                worker.start();
            }

            void stop() {
                stopped.set(true);
                HttpURLConnection active = connection;
                if (active != null) active.disconnect();
                synchronized (pauseLock) {
                    pauseLock.notifyAll();
                }
                Thread thread = worker;
                if (thread != null) thread.interrupt();
                setConnected(false);
            }

            void restart() {
                restartRequested.set(true);
                HttpURLConnection active = connection;
                if (active != null) active.disconnect();
                synchronized (pauseLock) {
                    pauseLock.notifyAll();
                }
            }

            void run() {
                ReconnectBackoff backoff = new ReconnectBackoff(1_000, 30_000);
                while (!stopped.get() && !MachineRuntime.this.stopped.get()) {
                    if (restartRequested.getAndSet(false)) backoff.reset();
                    HttpURLConnection current = null;
                    try {
                        current = openEventStream();
                        connection = current;
                        int status = current.getResponseCode();
                        String contentType = current.getContentType();
                        if (status != HttpURLConnection.HTTP_OK
                            || contentType == null
                            || !contentType.toLowerCase(Locale.US).contains("text/event-stream")) {
                            throw new IOException("HTTP " + status);
                        }
                        backoff.reset();
                        setConnected(true);
                        try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(current.getInputStream(), StandardCharsets.UTF_8)
                        )) {
                            StringBuilder frame = new StringBuilder();
                            String line;
                            while (!stopped.get()
                                && !MachineRuntime.this.stopped.get()
                                && (line = reader.readLine()) != null) {
                                BackgroundAttentionStatus.noteFrame(machine.id);
                                if (line.isEmpty()) {
                                    if (frame.length() > 0) {
                                        dispatchFrame(frame.toString());
                                        frame.setLength(0);
                                    }
                                    continue;
                                }
                                if (line.startsWith("data:")) {
                                    if (frame.length() > 0) frame.append('\n');
                                    String value = line.substring(5);
                                    frame.append(value.startsWith(" ") ? value.substring(1) : value);
                                    if (frame.length() > 1_000_000) frame.setLength(0);
                                }
                            }
                            if (frame.length() > 0 && !stopped.get() && !MachineRuntime.this.stopped.get()) {
                                dispatchFrame(frame.toString());
                            }
                        }
                        if (!stopped.get() && !MachineRuntime.this.stopped.get()) {
                            throw new IOException("stream ended");
                        }
                    } catch (Exception error) {
                        if (!stopped.get() && !MachineRuntime.this.stopped.get()) {
                            BackgroundAttentionStatus.setLastError(
                                machine.name + "/" + agent.label + ": " + describe(error)
                            );
                        }
                    } finally {
                        if (connection == current) connection = null;
                        if (current != null) current.disconnect();
                        setConnected(false);
                    }
                    if (stopped.get() || MachineRuntime.this.stopped.get()) break;
                    if (restartRequested.getAndSet(false)) {
                        backoff.reset();
                        continue;
                    }
                    pause(backoff.next());
                }
            }

            private void dispatchFrame(String data) {
                if (data == null || data.isEmpty()) return;
                AttentionNotificationCenter center = attentionNotifications;
                if (center != null) {
                    AttentionRequest request = AttentionEventParser.parse(
                        nativeMachineID,
                        nativeMachineName,
                        agent.id,
                        agent.label,
                        agent.questions,
                        agent.permissions,
                        data
                    );
                    if (request != null) {
                        if (request.transition == AttentionRequest.Transition.ASKED) center.show(request);
                        else center.resolve(request);
                    }
                }
                SessionOutcomeCenter outcomes = sessionOutcomes;
                if (outcomes == null) return;
                SessionOutcomeEvent outcome = SessionOutcomeParser.parse(
                    nativeMachineID,
                    nativeMachineName,
                    agent.id,
                    agent.label,
                    agent.backend,
                    data
                );
                if (outcome != null) {
                    outcomes.onEvent(outcome);
                } else {
                    scheduleOutcomePoll(data);
                }
            }

            /**
             * The ACP daemon used by DeepSeek/Claude/Codex emits message.updated and session.updated
             * but not the OpenCode-style session.idle/session.status frames. Poll the authoritative
             * Session list (debounced per active Session) so a completed turn still produces Ready.
             */
            private void scheduleOutcomePoll(String raw) {
                if (raw == null || (!raw.contains("\"message.updated\"") && !raw.contains("\"session.updated\""))) return;
                String sessionID;
                try {
                    JSONObject event = new JSONObject(raw);
                    sessionID = cleanIdentifier(event.optString("sessionId", event.optString("sessionID", "")));
                } catch (Exception ignored) {
                    return;
                }
                if (sessionID == null) return;
                synchronized (pendingOutcomePolls) {
                    if (!pendingOutcomePolls.add(sessionID)) return;
                }
                Handler handler = mainHandler;
                if (handler == null) {
                    synchronized (pendingOutcomePolls) { pendingOutcomePolls.remove(sessionID); }
                    return;
                }
                handler.postDelayed(() -> pollOutcome(sessionID), 1_500);
            }

            private void pollOutcome(String sessionID) {
                synchronized (pendingOutcomePolls) { pendingOutcomePolls.remove(sessionID); }
                if (stopped.get() || MachineRuntime.this.stopped.get()) return;
                HttpURLConnection poll = null;
                try {
                    poll = openJson(machine.baseUrl + "/v1/agents/" + encode(agent.id) + "/session");
                    if (poll.getResponseCode() != HttpURLConnection.HTTP_OK) return;
                    JSONArray sessions = new JSONArray(readBody(poll.getInputStream(), 4_000_000));
                    for (int index = 0; index < sessions.length(); index++) {
                        JSONObject session = sessions.optJSONObject(index);
                        if (session == null || !sessionID.equals(session.optString("id", ""))) continue;
                        String status = session.optString("status", "").trim().toLowerCase(Locale.US);
                        SessionOutcomeCenter center = sessionOutcomes;
                        if (center == null) return;
                        if ("idle".equals(status)) {
                            center.onEvent(new SessionOutcomeEvent(
                                SessionOutcomeEvent.Kind.IDLE,
                                nativeMachineID, nativeMachineName, agent.id, agent.label, sessionID, null
                            ));
                        } else if ("error".equals(status) || "failed".equals(status)) {
                            center.onEvent(new SessionOutcomeEvent(
                                SessionOutcomeEvent.Kind.FAILED,
                                nativeMachineID, nativeMachineName, agent.id, agent.label, sessionID,
                                "The Session stopped with an error."
                            ));
                        }
                        return;
                    }
                } catch (Exception ignored) {
                    // The next message.updated frame retries; this poll is best-effort.
                } finally {
                    if (poll != null) poll.disconnect();
                }
            }

            private HttpURLConnection openEventStream() throws IOException {
                HttpURLConnection connection = (HttpURLConnection) new URL(
                    BackgroundAttentionUrls.agentEvents(machine.baseUrl, agent.id)
                ).openConnection();
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept", "text/event-stream");
                connection.setRequestProperty("Authorization", BackgroundAttentionUrls.basicAuthorization(machine.username, machine.password));
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setUseCaches(false);
                return connection;
            }

            private void setConnected(boolean value) {
                if (connected == value) return;
                connected = value;
                updateConnected();
            }

            private void pause(long milliseconds) {
                if (stopped.get()) return;
                synchronized (pauseLock) {
                    if (stopped.get()) return;
                    try {
                        pauseLock.wait(Math.max(1L, milliseconds));
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
            }
        }
    }

    private static final class AgentInfo {
        final String id;
        final String label;
        final String backend;
        final boolean questions;
        final boolean permissions;

        AgentInfo(String id, String label, String backend, boolean questions, boolean permissions) {
            this.id = id;
            this.label = label;
            this.backend = backend;
            this.questions = questions;
            this.permissions = permissions;
        }
    }

    private static String readBody(InputStream input, int maximum) throws IOException {
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) != -1) {
                body.append(buffer, 0, read);
                if (body.length() > maximum) throw new IOException("machine snapshot too large");
            }
        }
        return body.toString();
    }

    private static String cleanIdentifier(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 256) return "";
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (character < 0x20 || character == 0x7f) return "";
        }
        return normalized;
    }

    private static String cleanDisplay(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 256) return "";
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (character < 0x20 || character == 0x7f) return "";
        }
        return normalized;
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return error.getClass().getSimpleName();
        String normalized = message.trim();
        return normalized.length() > 180 ? normalized.substring(0, 180) : normalized;
    }

    private static String safeLabel(String value) {
        if (value == null || value.isEmpty()) return "unknown";
        StringBuilder label = new StringBuilder();
        for (int index = 0; index < value.length() && label.length() < 32; index++) {
            char character = value.charAt(index);
            label.append(Character.isLetterOrDigit(character) ? character : '_');
        }
        return label.length() == 0 ? "unknown" : label.toString();
    }
}
