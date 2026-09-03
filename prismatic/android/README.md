# Prismatic — Android app

A WebView shell around the page one directory up. The web app is the single
source of truth: `app/build.gradle` copies exactly the files it needs into
`assets/www/` at build time, keeping their places in the tree, because the page
asks for `../styles/main.css` and those paths have to still mean something
inside the APK. The app and the page cannot drift apart.

## What the shell adds, and what it does not

**No permissions. Not one.** Everything happens inside the app: the page is
served from the APK, a mesh comes in through the file picker the system already
trusts the app to open, and the STEP file goes back out through the storage
picker, which hands over one destination and nothing else. Neither needs a
storage permission, and nothing here wants the network — a part you are
converting is nobody's business but yours. Anything the page asks for that is
not in the APK is refused with a 403, so a stray request fails loudly rather
than quietly reaching for something.

**A real file picker.** `onShowFileChooser` opens the system document picker, so
a mesh can come from internal storage, an SD card, Drive or Files.

**Opening a mesh with the app.** It answers `VIEW` and `SEND` for STL, OBJ and
3MF, by MIME type where the file manager knows one and by extension where it
does not. Android copies the file into the cache and the page pulls it across
the bridge a piece at a time — pulled rather than pushed, because thirty
megabytes cannot cross as one string and the page is the side that knows when it
can take it.

**Saving that works.** A blob download is a dead end inside a WebView, so the
file crosses the bridge in 192 KB pieces, base64 so that a binary STL and a text
STEP travel the same road, and lands in a temp file that the system storage
picker then places. What was sent and what arrived are counted on both sides: a
STEP file that stops in the middle of a face is worse than one that never
arrived, because it opens.

`test-ui-android.js` at the repository root drives all of that against a
stand-in for the native side, including a piece dropped mid-transfer, and reads
the file that comes out the far end back as a solid.

## Building

Needs a JDK (17 or 21) and the Android SDK with platform 34 and build-tools 34.

```bash
cd prismatic/android
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

- Application id `com.odpsstudio.prismatic` — its own app, beside the slicer
  rather than replacing it.
- `minSdk 26` (Android 8.0), `targetSdk 34`.
- 3MF needs a WebView with `DecompressionStream` (Chrome 103+). STL and OBJ
  work on any WebView the app supports.
