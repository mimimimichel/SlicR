# Web Slicer — Android app

A native WebView shell around the slicer that lives at the repository root. The
web app is the single source of truth: `app/build.gradle` copies `slicer.html`
and the assets it needs into `assets/www/` at build time, so the app and the
website can never drift apart.

## What the shell adds

- **Everything served from inside the APK.** `WebViewAssetLoader` answers over
  `https://appassets.androidplatform.net`, which gives the page a real origin so
  Web Workers, blob URLs and `localStorage` behave exactly as they do in a
  browser. Anything the page asks for that is not in the APK is refused with a
  403 in `shouldInterceptRequest`.
- **One permission: `INTERNET`,** and only since the app learned to hand a
  finished file to a printer. The page still cannot reach the network itself —
  every request it makes is either answered from the APK or refused. Printer
  traffic is made by the app, in Java, to the address the user typed and nowhere
  else, because a browser will not talk to a machine that has not invited it and
  no printer does. Models never leave the device; G-code goes to your printer
  when you press the button. Cleartext is allowed because OctoPrint on a home
  network is http.
- **A real file picker.** `onShowFileChooser` opens the system document picker,
  so models can come from internal storage, an SD card, Drive or Files.
- **Opening a model with the app.** It answers to `VIEW` and `SEND` for STL,
  OBJ, 3MF and G-code, by MIME type where the file manager knows one and by
  extension where it does not. Android copies the file into the cache and the
  page fetches it across the bridge a piece at a time — pulled rather than
  pushed, because a large model cannot cross as one string.
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
