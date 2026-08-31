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

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Single-activity shell around the browser slicer.
 *
 * The web app is served from https://appassets.androidplatform.net rather than
 * file:// — a real origin is what makes the Web Worker, blob URLs and
 * localStorage behave exactly as they do on the website. Nothing leaves the
 * device: the app holds no INTERNET permission and every request is answered
 * from the APK's own assets.
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
                return assetLoader.shouldInterceptRequest(request.getUrl());
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
                gcodeStream.write(chunk.getBytes(StandardCharsets.UTF_8));
                return true;
            } catch (IOException e) {
                Log.e(TAG, "appendSave failed", e);
                discardPendingGcode();
                return false;
            }
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
