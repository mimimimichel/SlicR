# SlicR

A 3D print slicer that runs entirely in the browser. Load an STL, 3MF or OBJ,
tune walls, infill and supports, watch every layer, and export G-code. Nothing
is uploaded — the mesh never leaves the machine it was opened on.

It is built for a tablet as much as a desktop: pointer-driven orbit and pinch,
touch-sized controls, and a panel that folds away.

There is also an Android wrapper in `android/` — a WebView serving the same
files from inside the APK. One permission, `INTERNET`, used only by the app
itself to hand a finished file to a printer on the local network; the page
cannot reach the network at all. It opens models sent to it from other apps,
too.

## Running it

Any static file server will do; there is no build step.

```
python3 -m http.server 8099
```

Then open <http://localhost:8099/>.

## What it does

**Generation.** Arachne-style variable-width walls across every loop, not just
the scraps: where the full wall stack does not fit, the beads that do are
widened to share the space and the ones that do not are dropped, with the
transitions ramped rather than stepped. Rectilinear, grid, triangles, gyroid,
honeycomb, cubic, concentric and lightning infill. Bridge detection with
per-bridge angle fitting, internal bridges over sparse infill, monotonic top
surfaces, ironing, fuzzy skin, scarf seams, arc fitting to G2/G3, and overhang
classification that slows each piece of a wall to what the air under it can
take.

**Supports.** Normal, and tree supports grown from the top down — branches that
thicken, lean together and reach the plate as a few trunks, using about half the
material and touching the part only at the tips.

**Painting.** Three brushes on the model itself: force support here, keep
support away, put the seam on this face. Marks follow the model through every
move, rotation and scale.

**Plates.** Print one object at a time, ordered front to back with the head
lifting clear between them, or all objects layer by layer. More than one tool is
supported, with a prime tower and per-object tool assignment.

**Custom G-code** goes through a small expression language — arithmetic,
comparisons, `{if}`/`{elsif}`/`{else}`/`{endif}` — so a profile can say "only
wait for the chamber if this machine has one" instead of shipping a command that
hangs a printer with no chamber.

**43 printer profiles** across Bambu Lab, Prusa, Creality, Elegoo, Anycubic,
Qidi, Voron, Artillery, Sovol and more, with per-machine bed shape, origin,
kinematics, Z speed and temperature ceilings.

## The G-code checker

Every export is read back by a verifier that walks the finished text the way the
printer would — not the generator's internal model, so it cannot share the
generator's mistakes. It checks temperature ceilings and cold extrusion, bed
bounds including the swept extremes of arcs, filament accounting, Z speed
against the machine's real limit, dangerous M-codes, and, when printing one
object at a time, any move that would cross a finished object at or below its
height.

It has earned its keep: it caught a delta profile whose origin convention put
every move off the bed, Z commanded at travel speed on leadscrew machines, end
scripts that retracted without resetting the extruder, and an arc fitted through
a corner that swept 260 mm off the side of the plate.

## Tests

```
node test-slicer.js              # 24 shapes x profiles x features, end to end
node test-arachne.js             # variable-width walls, measured on known shapes
node test-treesupport.js         # branches reach, merge, and miss the part
node test-paint.js               # enforcers, blockers, painted seams
node test-sequential.js          # one object at a time, and its collision rules
node test-multitool.js           # tool changes and the prime tower
node test-template.js            # the custom G-code expression language
node test-gcodecheck.js          # 35 injected faults the checker must catch
node test-profiles.js            # all 43 profiles with every feature on
```

### Measured against a reference

`test-vs-reference.js` and `test-vs-reference-sweep.js` slice the same shapes
through this engine and through PrusaSlicer's CLI, and compare material laid,
path length and pass counts. Where a prism is printed solid the exact volume is
known, so the geometry adjudicates rather than either engine.

```
apt-get install prusa-slicer
node test-vs-reference-sweep.js
```

Both skip cleanly when `prusa-slicer` is not installed. Over the 36 cases the
sweep can adjudicate against the exact geometry, this engine averages 0.89% off
the true volume with a worst case of 2.5%; the reference averages 2.85% with a
worst case of 10.4%. That comparison found most of the real defects in this
engine — spacing confused with width, solid surfaces narrower than a line,
infill left unconnected, walls thrown away at reflex corners.

## Android

```
cd android && ANDROID_HOME=/path/to/sdk ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`. The web app is the
single source of truth: the build copies `index.html`, `styles/` and `js/` into
the assets, so the app and the page cannot drift apart.

The application id is still `com.odpsstudio.webslicer`, from where this started.
Renaming it makes a separate app on the device rather than an update, so it is
left alone here.

## Layout

```
index.html            the page
styles/               main.css (tokens) and slicer.css
js/slicer/
  engine.js           slicing, path generation, G-code writing
  beading.js          medial axis and variable-width beads
  treesupport.js      branch growing
  lightning.js        lightning infill
  gcodecheck.js       the safety verifier
  template.js         the custom G-code expression language
  presets.js          printers, filaments, quality profiles
  meshtools.js        split and cut
  viewer.js           three.js scene, preview, painting
  app.js              UI
  worker.js           the slicing worker
js/vendor/            clipper, earcut, three.js
android/              the WebView wrapper
```
