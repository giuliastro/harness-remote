package ai.harness.remote;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Minimal authenticated-machine stand-in: one snapshot and one streaming agent endpoint. */
final class FakeMachineServer implements AutoCloseable {
    static final String MACHINE_ID = "machine-test";
    static final String AGENT_ID = "opencode";
    private static final String SNAPSHOT = "{\"machine\":{\"id\":\"" + MACHINE_ID + "\",\"name\":\"Test Machine\"},"
        + "\"agents\":[{\"id\":\"" + AGENT_ID + "\",\"label\":\"OpenCode\",\"backend\":\"opencode\","
        + "\"transport\":\"http\",\"managed\":true,\"state\":\"available\","
        + "\"capabilities\":{\"questions\":true,\"permissions\":true}}]}";

    private final ServerSocket server;
    private final Thread acceptThread;
    private final List<Socket> clients = Collections.synchronizedList(new ArrayList<>());
    private final BlockingQueue<String> events = new LinkedBlockingQueue<>();
    private volatile boolean closed;
    volatile int streamConnections;

    FakeMachineServer() throws IOException {
        server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        acceptThread = new Thread(this::acceptLoop, "fake-machine-accept");
        acceptThread.setDaemon(true);
    }

    void start() {
        acceptThread.start();
    }

    String baseUrl() {
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    void sendEvent(String data) {
        events.add(data);
    }

    void dropStreams() {
        List<Socket> snapshot;
        synchronized (clients) {
            snapshot = new ArrayList<>(clients);
        }
        for (Socket socket : snapshot) closeQuietly(socket);
        clients.clear();
    }

    @Override
    public void close() {
        closed = true;
        closeQuietly(server);
        dropStreams();
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                clients.add(socket);
                Thread handler = new Thread(() -> handle(socket), "fake-machine-client");
                handler.setDaemon(true);
                handler.start();
            } catch (IOException error) {
                return;
            }
        }
    }

    private void handle(Socket socket) {
        try {
            InputStream input = socket.getInputStream();
            String requestLine = readLine(input);
            if (requestLine == null) return;
            String header;
            while ((header = readLine(input)) != null && !header.isEmpty()) {
                // The service authenticates, but this fake only needs the request path.
            }
            String[] parts = requestLine.split(" ");
            String path = parts.length > 1 ? parts[1] : "";
            OutputStream output = socket.getOutputStream();
            if (path.startsWith("/v1/machine")) {
                byte[] body = SNAPSHOT.getBytes(StandardCharsets.UTF_8);
                output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                    + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                output.write(body);
                output.flush();
                return;
            }
            if (path.contains("/global/event")) {
                streamConnections++;
                output.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n"
                    + "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                writeChunk(output, ": connected\n\n");
                while (!closed && !socket.isClosed()) {
                    String event = events.poll(250, TimeUnit.MILLISECONDS);
                    if (event != null) writeChunk(output, "data: " + event + "\n\n");
                    else writeChunk(output, ": ping\n\n");
                }
            }
        } catch (Exception ignored) {
            // A dropped stream or a closed fake is the expected end of this connection.
        } finally {
            clients.remove(socket);
            closeQuietly(socket);
        }
    }

    private static void writeChunk(OutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        output.write((Integer.toHexString(bytes.length) + "\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(bytes);
        output.write("\r\n".getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') line.write(value);
            if (line.size() > 16_384) throw new IOException("header line too long");
        }
        if (value == -1 && line.size() == 0) return null;
        return line.toString(StandardCharsets.UTF_8.name());
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        try {
            closeable.close();
        } catch (Exception ignored) {
            // Test cleanup only.
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (Exception ignored) {
            // Test cleanup only.
        }
    }
}
