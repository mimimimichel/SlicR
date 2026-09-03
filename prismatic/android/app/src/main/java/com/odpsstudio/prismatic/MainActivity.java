package com.odpsstudio.prismatic;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
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

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;

/**
 * The whole of the Android app: a WebView with the page inside it, and a bridge
 * for the two things a WebView cannot do on its own — take a file in, and hand
 * one back out.
 *
 * The page is served from https://appassets.androidplatform.net rather than
 * file://, because a real origin is what makes blob URLs, localStorage and the
 * rest behave the way they do in a browser. Anything the page asks for that is
 * not in the APK is refused: there is no INTERNET permission here, so it could
 * not have been answered anyway, but saying no in one place is better than
 * finding out later that something tried.
 *
 * A mesh is tens of megabytes and a STEP file can be more, so neither crosses
 * the JS bridge as one string. Both go in pieces: in comes pulled by the page
 * when it is ready, out goes pushed into a temp file and then copied to
 * wherever the system's storage picker points. That way neither direction
 * needs a storage permission, and neither needs to fit in memory twice.
 */
public class MainActivity extends Activity {

    private static final String TAG = "Prismatic";
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String APP_URL = ORIGIN + "/assets/www/prismatic/index.html";

    private static final int REQ_PICK_MESH = 1001;
    private static final int REQ_SAVE_FILE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFilePicker;

    /** What the page is writing out, buffered here until the user picks a home for it. */
    private File pendingFile;
    private String pendingName;
    private String pendingMime;
    private FileOutputStream pendingStream;
    private long pendingBytes;

    /** A mesh handed to the app from somewhere else, waiting for the page to fetch it. */
    private File incomingFile;
    private String incomingName;

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
        settings.setTextZoom(100);   // the page sizes itself; ignore the system font scale

        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(@NonNull WebView view, @NonNull WebResourceRequest request) {
                WebResourceResponse asset = assetLoader.shouldInterceptRequest(request.getUrl());
                if (asset != null) return asset;
                return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked",
                        java.util.Collections.emptyMap(),
                        new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
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
                try {
                    startActivityForResult(Intent.createChooser(pick, getString(R.string.pick_model)), REQ_PICK_MESH);
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

        webView.addJavascriptInterface(new Bridge(), "AndroidPrismatic");

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(APP_URL);

        takeIncoming(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // The activity is singleTask, so a second "open with" lands here rather
        // than in a second copy of the app.
        if (takeIncoming(intent)) {
            runOnUiThread(() -> webView.evaluateJavascript(
                    "(function(){if(window.PrismaticAndroidOpen)window.PrismaticAndroidOpen();})()", null));
        }
    }

    /** Copy whatever was opened into the cache. Returns true if there was one. */
    private boolean takeIncoming(@Nullable Intent intent) {
        if (intent == null) return false;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return false;

        String name = displayName(uri);
        try {
            File dir = new File(getCacheDir(), "incoming");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            File out = new File(dir, "mesh.bin");
            try (InputStream in = getContentResolver().openInputStream(uri);
                 FileOutputStream to = new FileOutputStream(out)) {
                if (in == null) throw new IOException("nothing to read at " + uri);
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) to.write(buf, 0, n);
            }
            incomingFile = out;
            incomingName = name;
            return true;
        } catch (Exception e) {
            Log.e(TAG, "could not take the file that was opened", e);
            incomingFile = null;
            incomingName = null;
            toast(getString(R.string.open_failed));
            return false;
        }
    }

    /** The name the file had where it came from, which is what the user knows it by. */
    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                    if (i >= 0) name = c.getString(i);
                }
            } catch (Exception ignored) { }
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "mesh.stl" : name;
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        closePending();
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

        if (requestCode == REQ_PICK_MESH) {
            if (pendingFilePicker == null) return;
            pendingFilePicker.onReceiveValue(resultCode == RESULT_OK ? extractUris(data) : null);
            pendingFilePicker = null;

        } else if (requestCode == REQ_SAVE_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                copyPendingTo(data.getData());
            }
            discardPending();
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

    private void copyPendingTo(Uri target) {
        if (pendingFile == null || !pendingFile.exists()) return;
        try (FileInputStream in = new FileInputStream(pendingFile);
             OutputStream out = getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IOException("no output stream for " + target);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            out.flush();
            toast(getString(R.string.saved) + " " + pendingName);
        } catch (IOException e) {
            Log.e(TAG, "saving failed", e);
            toast(getString(R.string.save_failed));
        }
    }

    private void closePending() {
        if (pendingStream == null) return;
        try { pendingStream.close(); } catch (IOException ignored) { }
        pendingStream = null;
    }

    private void discardPending() {
        closePending();
        if (pendingFile != null) {
            // The temp file holds the user's part; it does not stay in the
            // cache once it has been handed over or abandoned.
            if (!pendingFile.delete()) pendingFile.deleteOnExit();
        }
        pendingFile = null;
        pendingName = null;
        pendingMime = null;
        pendingBytes = 0;
    }

    private void toast(final String message) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
    }

    /** Nothing but a name: no directories, no surprises from another app's idea of one. */
    private static String sanitise(String name) {
        if (name == null || name.isEmpty()) return "part.step";
        String clean = name.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
        if (clean.isEmpty()) clean = "part.step";
        return clean.length() > 96 ? clean.substring(clean.length() - 96) : clean;
    }

    // -----------------------------------------------------------------------
    // The bridge
    // -----------------------------------------------------------------------

    private class Bridge {

        /**
         * Start a file. Everything the page sends after this is appended, in
         * base64, which costs a third more over the wire and is worth it: a
         * binary STL and a text STEP then travel the same way, and neither
         * arrives with its bytes reinterpreted as characters.
         */
        @JavascriptInterface
        public boolean beginSave(String filename, String mime) {
            discardPending();
            try {
                File dir = new File(getCacheDir(), "outgoing");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                pendingName = sanitise(filename);
                pendingMime = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
                pendingFile = new File(dir, "pending.bin");
                pendingStream = new FileOutputStream(pendingFile);
                pendingBytes = 0;
                return true;
            } catch (IOException e) {
                Log.e(TAG, "beginSave failed", e);
                discardPending();
                return false;
            }
        }

        @JavascriptInterface
        public boolean appendSave(String chunk) {
            if (pendingStream == null || chunk == null) return false;
            try {
                byte[] bytes = Base64.decode(chunk, Base64.DEFAULT);
                pendingStream.write(bytes);
                pendingStream.flush();
                pendingBytes += bytes.length;
                return true;
            } catch (IllegalArgumentException | IOException e) {
                Log.e(TAG, "appendSave failed", e);
                discardPending();
                return false;
            }
        }

        /**
         * How many bytes have arrived. The page compares this with what it sent,
         * so a piece lost on the way is an error somebody sees rather than a
         * STEP file that stops in the middle of a face.
         *
         * A string, because the bridge marshals numbers loosely and this one has
         * to be exact.
         */
        @JavascriptInterface
        public String pendingBytes() {
            return String.valueOf(pendingBytes);
        }

        @JavascriptInterface
        public void discardSave() {
            discardPending();
        }

        /** Everything has arrived; ask the user where it goes. */
        @JavascriptInterface
        public void endSave() {
            closePending();
            if (pendingFile == null || !pendingFile.exists()) return;
            final String name = pendingName;
            final String mime = pendingMime;
            runOnUiThread(() -> {
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE);
                save.setType(mime);
                save.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(Intent.createChooser(save, getString(R.string.save_file)), REQ_SAVE_FILE);
                } catch (ActivityNotFoundException e) {
                    discardPending();
                    toast(getString(R.string.save_failed));
                }
            });
        }

        /** The name of the mesh the app was opened with, or an empty string. */
        @JavascriptInterface
        public String incomingName() {
            return incomingName == null ? "" : incomingName;
        }

        @JavascriptInterface
        public String incomingSize() {
            return incomingFile == null ? "0" : String.valueOf(incomingFile.length());
        }

        /** A piece of it, base64, pulled when the page is ready for it. */
        @JavascriptInterface
        public String incomingChunk(String offsetText, String lengthText) {
            if (incomingFile == null) return "";
            try {
                long offset = Long.parseLong(offsetText);
                int length = Integer.parseInt(lengthText);
                if (offset < 0 || length <= 0) return "";
                long left = incomingFile.length() - offset;
                if (left <= 0) return "";
                if (length > left) length = (int) left;
                byte[] buf = new byte[length];
                try (RandomAccessFile in = new RandomAccessFile(incomingFile, "r")) {
                    in.seek(offset);
                    in.readFully(buf);
                }
                return Base64.encodeToString(buf, Base64.NO_WRAP);
            } catch (Exception e) {
                Log.e(TAG, "incomingChunk failed", e);
                return "";
            }
        }

        @JavascriptInterface
        public void incomingDone() {
            if (incomingFile != null && !incomingFile.delete()) incomingFile.deleteOnExit();
            incomingFile = null;
            incomingName = null;
        }

        @JavascriptInterface
        public void toast(String message) {
            MainActivity.this.toast(message);
        }
    }
}
