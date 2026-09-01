package com.odpsstudio.webslicer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.JsResult;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Single-activity shell around the browser slicer.
 *
 * The web app is served from https://appassets.androidplatform.net rather than
 * file:// — a real origin is what makes the Web Worker, blob URLs and
 * localStorage behave exactly as they do on the website. Every request the page
 * makes is answered from the APK's own assets or refused — the page cannot
 * reach the network at all. The app can, for exactly one thing: handing a
 * finished G-code file to an OctoPrint the user has entered the address of.
 */
public class MainActivity extends Activity {

    private static final String TAG = "WebSlicer";
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String APP_URL = ORIGIN + "/assets/www/index.html";

    private static final int REQ_PICK_MODEL = 1001;
    private static final int REQ_SAVE_GCODE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFilePicker;

    /** G-code is streamed from JS into this temp file, then copied where the user picks. */
    private File pendingGcodeFile;
    private String pendingGcodeName;
    private FileOutputStream gcodeStream;
    /** Bytes actually written for the file being streamed, so the page can check. */
    private long pendingGcodeBytes;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF06080D);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);   // the UI sizes itself; ignore the system font scale

        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(@NonNull WebView view, @NonNull WebResourceRequest request) {
                WebResourceResponse asset = assetLoader.shouldInterceptRequest(request.getUrl());
                if (asset != null) return asset;
                // The app has the INTERNET permission now, for the OctoPrint
                // upload. That is the app's to make, not the page's: anything
                // the page asks for that is not in the APK gets nothing back.
                return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked",
                        java.util.Collections.emptyMap(),
                        new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                // Everything real lives inside the APK; refuse to navigate anywhere else.
                return !request.getUrl().toString().startsWith(ORIGIN + "/");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFilePicker != null) pendingFilePicker.onReceiveValue(null);
                pendingFilePicker = callback;

                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");   // STL and 3MF have no dependable MIME type
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(pick, getString(R.string.pick_model)), REQ_PICK_MODEL);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFilePicker = null;
                    callback.onReceiveValue(null);
                    toast(getString(R.string.no_file_app));
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }
        });

        webView.addJavascriptInterface(new Bridge(), "AndroidSlicer");

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // Let the page close its settings sheet first; only then leave the app.
        webView.evaluateJavascript(
                "(function(){return window.OrcaAndroidBack ? !!window.OrcaAndroidBack() : false;})()",
                value -> {
                    if (!"true".equals(value)) finish();
                });
    }

    @Override
    protected void onDestroy() {
        closeGcodeStream();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // -----------------------------------------------------------------------
    // Activity results
    // -----------------------------------------------------------------------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_PICK_MODEL) {
            if (pendingFilePicker == null) return;
            pendingFilePicker.onReceiveValue(resultCode == RESULT_OK ? extractUris(data) : null);
            pendingFilePicker = null;

        } else if (requestCode == REQ_SAVE_GCODE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                writeGcodeTo(data.getData());
            }
            discardPendingGcode();
        }
    }

    @Nullable
    private Uri[] extractUris(@Nullable Intent data) {
        if (data == null) return null;
        if (data.getClipData() != null) {
            int n = data.getClipData().getItemCount();
            Uri[] uris = new Uri[n];
            for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
            return uris;
        }
        if (data.getData() != null) return new Uri[]{data.getData()};
        return null;
    }

    private void writeGcodeTo(Uri target) {
        if (pendingGcodeFile == null || !pendingGcodeFile.exists()) return;
        try (FileInputStream in = new FileInputStream(pendingGcodeFile);
             OutputStream out = getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IOException("no output stream for " + target);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            out.flush();
            toast(getString(R.string.saved_to));
        } catch (IOException e) {
            Log.e(TAG, "saving G-code failed", e);
            toast(getString(R.string.save_failed));
        }
    }

    // -----------------------------------------------------------------------
    // JS bridge
    // -----------------------------------------------------------------------

    /**
     * G-code can run to tens of megabytes, so it crosses the bridge in chunks and
     * is buffered to a temp file. Once it is complete the user picks a
     * destination through the storage picker — no storage permission needed.
     */
    private class Bridge {

        @JavascriptInterface
        public boolean beginSave(String filename) {
            closeGcodeStream();
            try {
                File dir = new File(getCacheDir(), "gcode");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                pendingGcodeName = sanitise(filename);
                pendingGcodeFile = new File(dir, "pending.gcode");
                gcodeStream = new FileOutputStream(pendingGcodeFile);
                pendingGcodeBytes = 0;
                return true;
            } catch (IOException e) {
                Log.e(TAG, "beginSave failed", e);
                discardPendingGcode();
                return false;
            }
        }

        @JavascriptInterface
        public boolean appendSave(String chunk) {
            if (gcodeStream == null || chunk == null) return false;
            try {
                byte[] bytes = chunk.getBytes(StandardCharsets.UTF_8);
                gcodeStream.write(bytes);
                gcodeStream.flush();
                pendingGcodeBytes += bytes.length;
                return true;
            } catch (IOException e) {
                Log.e(TAG, "appendSave failed", e);
                discardPendingGcode();
                return false;
            }
        }

        /**
         * How many bytes have arrived. A megabytes-long file crosses this
         * bridge in dozens of pieces; the page compares this with what it sent
         * so that a piece lost on the way is an error the user sees, not a
         * G-code file that stops halfway through the print.
         *
         * A string, because the bridge marshals numbers loosely and this one
         * has to be exact.
         */
        @JavascriptInterface
        public String pendingBytes() {
            return String.valueOf(pendingGcodeBytes);
        }

        /** Abandon a transfer that did not arrive intact. */
        @JavascriptInterface
        public void discardSave() {
            discardPendingGcode();
        }

        @JavascriptInterface
        public void endSave() {
            closeGcodeStream();
            if (pendingGcodeFile == null || !pendingGcodeFile.exists()) return;
            final String name = pendingGcodeName;
            runOnUiThread(() -> {
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE);
                save.setType("text/x-gcode");
                save.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(Intent.createChooser(save, getString(R.string.save_gcode)), REQ_SAVE_GCODE);
                } catch (ActivityNotFoundException e) {
                    discardPendingGcode();
                    toast(getString(R.string.save_failed));
                }
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            MainActivity.this.toast(message);
        }

        /**
         * Find printers the way their own software does: shout on the network
         * and see who answers.
         *
         * A browser cannot send a UDP packet, so the page falls back to knocking
         * on every address in turn. Here there is no need for any of that — the
         * two protocols each define a broadcast, and the machines answer it in
         * milliseconds with their own name and model.
         *
         *   Elegoo Centauri Carbon 2   {"id":0,"method":7000} to port 52700
         *   Elegoo Centauri Carbon     "M99999" to port 3000
         *
         * Answers go back through window.OrcaDiscoverResult as JSON.
         */
        @JavascriptInterface
        public void discover() {
            new Thread(() -> {
                String json;
                try {
                    json = discoverPrinters();
                } catch (Exception e) {
                    Log.e(TAG, "discovery failed", e);
                    json = "[]";
                }
                final String payload = json;
                runOnUiThread(() -> {
                    if (webView == null) return;
                    webView.evaluateJavascript(
                            "window.OrcaDiscoverResult && window.OrcaDiscoverResult(" +
                                    jsonString(payload) + ");", null);
                });
            }, "printer-discovery").start();
        }

        /**
         * Hand the file that beginSave/appendSave just streamed to an OctoPrint,
         * rather than letting the page do it. The page is served from an https
         * origin and a printer on a home network is http, which a browser blocks
         * outright and no setting on the page can undo; and doing it here means
         * the API key and the file go to that one host over one connection this
         * code opened, with no cross-origin machinery in between.
         *
         * Answers asynchronously through window.OrcaOctoResult(ok, message).
         */
        /**
         * One HTTP request, made from here rather than from the page.
         *
         * A browser will not let a page talk to a printer that has not invited
         * it, and printers do not invite anyone: OctoPrint ships with
         * cross-origin requests off, and a printer's own web server has never
         * heard of them. Worse, the page is served over https from the app's
         * asset host while the printer is plain http, which is blocked before
         * CORS is even considered. None of those rules apply out here.
         *
         * Answers asynchronously through window.OrcaNetResult, so a slow
         * printer never freezes the page.
         */
        @JavascriptInterface
        public void httpRequest(final String id, final String method, final String url,
                                final String headersJson, final String body) {
            sendRequest(id, method, url, headersJson, body, null);
        }

        /**
         * The same, with the body taken from the file the page has already
         * streamed across in pieces — a G-code upload is megabytes, and a
         * single bridge call cannot carry that.
         */
        @JavascriptInterface
        public void httpRequestStaged(final String id, final String method, final String url,
                                      final String headersJson) {
            final File staged = pendingGcodeFile;
            closeGcodeStream();
            if (staged == null || !staged.exists()) {
                netResult(id, 0, "", "Nothing was staged to send.");
                return;
            }
            sendRequest(id, method, url, headersJson, null, staged);
        }

        @JavascriptInterface
        public void octoSend(final String baseUrl, final String apiKey, final boolean startPrint) {
            final File file = pendingGcodeFile;
            final String name = pendingGcodeName;
            closeGcodeStream();
            if (file == null || !file.exists()) {
                octoResult(false, "Nothing was prepared to send.");
                return;
            }
            new Thread(() -> {
                try {
                    postToOctoPrint(baseUrl, apiKey, name, file, startPrint);
                    octoResult(true, startPrint
                            ? name + " is uploaded and printing."
                            : name + " is on the printer and selected.");
                } catch (Exception e) {
                    Log.e(TAG, "OctoPrint upload failed", e);
                    octoResult(false, e.getMessage() == null ? e.toString() : e.getMessage());
                } finally {
                    runOnUiThread(MainActivity.this::discardPendingGcode);
                }
            }, "octoprint-upload").start();
        }
    }

    /**
     * Perform one request on a worker thread and hand the answer back to the
     * page. A printer that refuses, times out or is not there is an answer
     * too — the page decides what to say about it.
     */
    private void sendRequest(final String id, final String method, final String url,
                             final String headersJson, final String body, final File staged) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                for (Map.Entry<String, String> h : parseHeaders(headersJson).entrySet()) {
                    conn.setRequestProperty(h.getKey(), h.getValue());
                }

                if (staged != null) {
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(staged.length());
                    try (FileInputStream in = new FileInputStream(staged);
                         OutputStream out = conn.getOutputStream()) {
                        byte[] buf = new byte[64 * 1024];
                        int read;
                        while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
                        out.flush();
                    }
                } else if (body != null && !body.isEmpty()) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = conn.getOutputStream()) { out.write(bytes); }
                }

                int status = conn.getResponseCode();
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                netResult(id, status, in == null ? "" : readAll(in), null);
            } catch (Exception e) {
                Log.e(TAG, "request to " + url + " failed", e);
                netResult(id, 0, "", e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                if (staged != null) runOnUiThread(MainActivity.this::discardPendingGcode);
            }
        }, "printer-request").start();
    }

    private Map<String, String> parseHeaders(String json) {
        Map<String, String> out = new LinkedHashMap<>();
        if (json == null) return out;
        // Flat {"Name":"value"} only, which is all the page ever sends.
        Matcher m = Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
                .matcher(json);
        while (m.find()) out.put(unescape(m.group(1)), unescape(m.group(2)));
        return out;
    }

    private String unescape(String s) {
        return s.replace("\\\"", "\"").replace("\\\\", "\\\\")
                .replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t");
    }

    private String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        int read;
        // Enough of an answer to read, not so much that a printer streaming
        // something enormous can fill memory.
        while ((read = in.read(chunk)) > 0 && buf.size() < 2 * 1024 * 1024) buf.write(chunk, 0, read);
        return buf.toString("UTF-8");
    }

    /** Hand one request's answer back to the page. */
    private void netResult(final String id, final int status, final String body, final String error) {
        final String call = "window.OrcaNetResult && window.OrcaNetResult("
                + jsonString(id) + "," + status + "," + jsonString(body == null ? "" : body) + ","
                + (error == null ? "null" : jsonString(error)) + ")";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(call, null);
        });
    }

    private void octoResult(final boolean ok, final String message) {
        // The message has to survive being pasted into a script, so it crosses
        // as a JSON string rather than by concatenation.
        final String safe = jsonString(message == null ? "" : message);
        runOnUiThread(() -> {
            if (webView == null) return;
            webView.evaluateJavascript(
                    "window.OrcaOctoResult && window.OrcaOctoResult(" + ok + "," + safe + ");", null);
        });
    }

    // -----------------------------------------------------------------------
    // Finding printers
    // -----------------------------------------------------------------------

    /** One broadcast per protocol, and everything that answered inside a second. */
    private String discoverPrinters() {
        Map<String, String> found = new LinkedHashMap<>();     // host -> JSON object
        List<InetAddress> broadcasts = broadcastAddresses();

        askAndCollect(broadcasts, 52700, "{\"id\": 0, \"method\": 7000}", found, true);
        askAndCollect(broadcasts, 3000, "M99999", found, false);

        StringBuilder out = new StringBuilder("[");
        boolean first = true;
        for (String value : found.values()) {
            if (!first) out.append(',');
            out.append(value);
            first = false;
        }
        return out.append(']').toString();
    }

    /** Every broadcast address this device's own interfaces have. */
    private List<InetAddress> broadcastAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nics = NetworkInterface.getNetworkInterfaces();
            while (nics != null && nics.hasMoreElements()) {
                NetworkInterface nic = nics.nextElement();
                if (nic.isLoopback() || !nic.isUp()) continue;
                for (InterfaceAddress addr : nic.getInterfaceAddresses()) {
                    InetAddress b = addr.getBroadcast();
                    if (b != null) out.add(b);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "could not list interfaces", e);
        }
        return out;
    }

    /**
     * Send one message to every broadcast address and gather the replies for a
     * second. Printers answer directly rather than broadcasting back, so the
     * same socket hears them.
     */
    private void askAndCollect(List<InetAddress> broadcasts, int port, String message,
                               Map<String, String> found, boolean elegooCc2) {
        if (broadcasts.isEmpty()) return;
        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket();
            socket.setBroadcast(true);
            socket.setSoTimeout(300);
            byte[] payload = message.getBytes(StandardCharsets.UTF_8);
            for (InetAddress b : broadcasts) {
                try {
                    socket.send(new DatagramPacket(payload, payload.length, b, port));
                } catch (IOException ignored) { /* one interface being deaf is normal */ }
            }

            long until = System.currentTimeMillis() + 1200;
            byte[] buffer = new byte[8192];
            while (System.currentTimeMillis() < until) {
                DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(reply);
                } catch (IOException timeout) {
                    continue;                                  // nothing yet; keep listening
                }
                String host = reply.getAddress().getHostAddress();
                String body = new String(reply.getData(), 0, reply.getLength(), StandardCharsets.UTF_8);
                String device = elegooCc2 ? readCc2(host, body) : readSdcp(host, body);
                if (device != null && !found.containsKey(host)) found.put(host, device);
            }
        } catch (Exception e) {
            Log.w(TAG, "broadcast on " + port + " failed", e);
        } finally {
            if (socket != null) socket.close();
        }
    }

    /**
     * The Centauri Carbon 2 answers with {"id":.., "result":{...}}. Parsed by
     * hand rather than with a JSON library, because the fields wanted are three
     * strings and the alternative is a dependency.
     */
    private String readCc2(String host, String body) {
        if (!body.contains("result")) return null;
        String name = jsonField(body, "host_name");
        String model = jsonField(body, "machine_model");
        String serial = jsonField(body, "sn");
        if (name.isEmpty() && model.isEmpty() && serial.isEmpty()) return null;
        return "{\"host\":" + jsonString(host) + ",\"port\":80,\"kind\":\"elegoo_cc2\"" +
                ",\"label\":\"Elegoo Centauri Carbon 2\"" +
                ",\"name\":" + jsonString(name.isEmpty() ? (model.isEmpty() ? "Centauri Carbon 2" : model) : name) +
                ",\"serial\":" + jsonString(serial) + "}";
    }

    /** The first Centauri Carbon, and anything else speaking SDCP. */
    private String readSdcp(String host, String body) {
        if (!body.contains("Data") && !body.contains("MainboardID") && !body.contains("Name")) return null;
        String name = jsonField(body, "Name");
        String machine = jsonField(body, "MachineName");
        String board = jsonField(body, "MainboardID");
        return "{\"host\":" + jsonString(host) + ",\"port\":3030,\"kind\":\"elegoo_cc1\"" +
                ",\"label\":\"Elegoo Centauri Carbon\"" +
                ",\"name\":" + jsonString(!name.isEmpty() ? name : (!machine.isEmpty() ? machine : "Centauri Carbon")) +
                ",\"serial\":" + jsonString(board) + "}";
    }

    /** The value of one string field, without pulling in a JSON parser. */
    private static String jsonField(String body, String key) {
        String needle = "\"" + key + "\"";
        int at = body.indexOf(needle);
        if (at < 0) return "";
        int colon = body.indexOf(':', at + needle.length());
        if (colon < 0) return "";
        int open = body.indexOf('"', colon);
        if (open < 0) return "";
        StringBuilder value = new StringBuilder();
        for (int i = open + 1; i < body.length(); i++) {
            char c = body.charAt(i);
            if (c == '\\' && i + 1 < body.length()) { value.append(body.charAt(++i)); continue; }
            if (c == '"') break;
            value.append(c);
        }
        return value.toString();
    }

    /** Minimal JSON string escaping — enough to carry an error message safely. */
    private static String jsonString(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }

    /**
     * One multipart POST to /api/files/local, written by hand because the file
     * can be tens of megabytes and there is no reason to hold it in memory.
     */
    private void postToOctoPrint(String baseUrl, String apiKey, String name, File file, boolean startPrint)
            throws IOException {
        String base = baseUrl == null ? "" : baseUrl.trim();
        if (base.isEmpty()) throw new IOException("No OctoPrint address set.");
        if (!base.matches("(?i)^https?://.*")) base = "http://" + base;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);

        String boundary = "----slicr" + System.currentTimeMillis();
        String dash = "--";
        String crlf = "\r\n";

        HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/files/local").openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("X-Api-Key", apiKey == null ? "" : apiKey);
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        conn.setFixedLengthStreamingMode(multipartLength(boundary, name, file, startPrint));

        try (OutputStream raw = conn.getOutputStream();
             BufferedOutputStream out = new BufferedOutputStream(raw)) {
            out.write((dash + boundary + crlf).getBytes(StandardCharsets.UTF_8));
            out.write(("Content-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"" + crlf)
                    .getBytes(StandardCharsets.UTF_8));
            out.write(("Content-Type: text/x.gcode" + crlf + crlf).getBytes(StandardCharsets.UTF_8));
            try (FileInputStream in = new FileInputStream(file)) {
                byte[] buf = new byte[64 * 1024];
                int read;
                while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
            }
            out.write(crlf.getBytes(StandardCharsets.UTF_8));
            // Selecting is what makes it the loaded job; printing is only ever
            // sent when the user asked for it and confirmed it.
            writeField(out, boundary, "select", "true");
            if (startPrint) writeField(out, boundary, "print", "true");
            out.write((dash + boundary + dash + crlf).getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        int status = conn.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IOException(explainStatus(status, base));
        }
        InputStream body = conn.getInputStream();
        if (body != null) body.close();
    }

    private static void writeField(OutputStream out, String boundary, String key, String value) throws IOException {
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"" + key + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write((value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }

    private static long multipartLength(String boundary, String name, File file, boolean startPrint) {
        long len = 0;
        len += ("--" + boundary + "\r\n").length();
        len += ("Content-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"\r\n").length();
        len += ("Content-Type: text/x.gcode\r\n\r\n").length();
        len += file.length();
        len += 2;                                            // the CRLF after the file
        len += fieldLength(boundary, "select", "true");
        if (startPrint) len += fieldLength(boundary, "print", "true");
        len += ("--" + boundary + "--\r\n").length();
        return len;
    }

    private static long fieldLength(String boundary, String key, String value) {
        return ("--" + boundary + "\r\n").length()
                + ("Content-Disposition: form-data; name=\"" + key + "\"\r\n\r\n").length()
                + (value + "\r\n").length();
    }

    /** The same sentences the browser build gives, for the same status codes. */
    private static String explainStatus(int status, String base) {
        switch (status) {
            case 401:
            case 403:
                return "OctoPrint refused the API key. Copy it again from Settings \u2192 API.";
            case 404:
                return "Nothing answered at " + base + ". Check the address.";
            case 409:
                return "The printer is not ready: not connected, or already printing.";
            case 413:
                return "OctoPrint rejected the file as too large.";
            case 415:
                return "OctoPrint would not take this as a G-code file.";
            default:
                if (status >= 500) return "OctoPrint failed on its side (" + status + ").";
                return "OctoPrint answered " + status + ".";
        }
    }

    private static String sanitise(String filename) {
        String name = filename == null ? "" : filename.replaceAll("[^A-Za-z0-9._-]", "_");
        if (name.isEmpty()) name = "print.gcode";
        if (!name.toLowerCase().endsWith(".gcode")) name = name + ".gcode";
        return name;
    }

    private void closeGcodeStream() {
        if (gcodeStream != null) {
            try { gcodeStream.close(); } catch (IOException ignored) { }
            gcodeStream = null;
        }
    }

    private void discardPendingGcode() {
        closeGcodeStream();
        pendingGcodeBytes = 0;
        if (pendingGcodeFile != null) {
            if (!pendingGcodeFile.delete()) pendingGcodeFile.deleteOnExit();
            pendingGcodeFile = null;
        }
        pendingGcodeName = null;
    }

    private void toast(final String message) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
    }
}
