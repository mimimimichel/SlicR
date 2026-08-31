# Web Slicer — Android app

A native WebView shell around the slicer that lives at the repository root. The
web app is the single source of truth: `app/build.gradle` copies `index.html`
and the assets it needs into `assets/www/` at build time, so the app and the
website can never drift apart.

## What the shell adds

- **Fully offline.** The app declares **no permissions at all** — deliberately
  not even `INTERNET`. Assets are served from inside the APK by
  `WebViewAssetLoader` over `https://appassets.androidplatform.net`, which gives
  the page a real origin so Web Workers, blob URLs and `localStorage` behave
  exactly as they do in a browser.
- **A real file picker.** `onShowFileChooser` opens the system document picker,
  so models can come from internal storage, an SD card, Drive or Files.
- **G-code export that works.** A blob download is a dead end inside a WebView,
  so the G-code crosses the JS bridge in 256 KB chunks into a temp file, and the
  system storage picker chooses where it lands. No storage permission required.
- **Back button** closes the settings sheet before leaving the app.

If the WebView ever refuses to serve the worker script, the page falls back to
slicing on the main thread — see `sliceInPage()` in `js/slicer/app.js`.

## Building

Needs a JDK (17 or 21) and the Android SDK with platform 34 and build-tools 34.

```bash
cd android
echo "sdk.dir=/path/to/Android/sdk" > local.properties
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

For a release build, add a signing config to `app/build.gradle` and run
`./gradlew assembleRelease`.

## Installing

The debug APK is signed with the local debug keystore, so Android will ask you
to allow installs from unknown sources. If you later install a build signed with
a different key, uninstall the old one first.

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- `minSdk 26` (Android 8.0)
- `targetSdk 34`
- 3MF support needs a WebView with `DecompressionStream` (Chrome 103+). STL and
  OBJ work on any WebView the app supports.
