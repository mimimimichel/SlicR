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

node test-prismatic.js           # mesh to solid, on shapes whose volume is known
node test-step.js                # and the STEP written from it, read back cold
node test-ui-prismatic.js        # the app around both, down to the saved files
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

## Prismatic

`prismatic/` is a second app in the same repo, with its own page and nothing to
do with slicing. It turns a triangle mesh back into a solid the way Fusion's
*Convert Mesh > Prismatic* does: an STL is a solid that was chopped up, so the
flat faces are found and each fitted to one exact plane, every vertex is moved
onto the corner where its planes cross, and each face is re-triangulated from
its outline instead of keeping the fan of facets. In goes an STL, OBJ or 3MF.

Out comes **STEP**, which is the point of it. A mesh is a bag of triangles that
every program opening it has to guess at; a STEP file says here is a point, here
is the edge between two points, here is the plane, here is the face those edges
bound, and here is the closed shell they make. Fusion opens that as a solid
body — faces you can click, fillet, sketch on and cut — so the part is editable
again rather than merely printable. STL comes out too, for printing.

Writing that file is not a second conversion: the faces, their planes and their
loops all fall out of the rebuild already. What takes the care is that the edges
are *shared* — one edge between the two faces that meet along it, traversed the
other way by the second — and that outlines run anticlockwise about the face
normal while holes run the other way. Get either wrong and what arrives in
Fusion is a heap of surfaces that will not take a fillet. A mesh with a hole in
it is not a solid and is not written as one: it comes out as surfaces, said so
in the file and in the app, which Fusion will offer to stitch.

```
python3 -m http.server 8099
```

Then open <http://localhost:8099/prismatic/>.

What the conversion found is drawn rather than only reported: every face gets
its own colour and the edges between faces are drawn over the top, so a part
whose faces were found properly reads as a handful of flat colours with the
part's real edges between them, and one where they were not is a confetti of
patches you can see at a glance. Tolerances can then be dialled in against the
picture, and Convert only ever does what is already on the screen.

It is deliberately timid about what it will do to a part. Each rebuilt face is
measured against the facets it replaces, and the finished body against the
volume and the seams of the one it came from; what does not add up comes back
untouched with the reason. A mesh that was never prismatic — a scan, a sculpt —
is named as one before you press anything.

`test-step.js` reads the written file back knowing nothing about the code that
wrote it — its own part 21 parser, then the questions a solid modeller asks. Is
every reference resolved, is every edge used exactly twice and in opposite
directions, does every loop close, do the corners of a face lie on the plane it
claims, do the outlines turn the right way — and then the one that catches
whatever the others missed: what volume do those faces enclose, computed from
the file alone. For a 20 x 30 x 10 box it is 6000.000 mm3.

There is no B-rep kernel in a web page, so what comes out is still a mesh.
Anything genuinely curved is faceted to the deviation you set, which is what
the warning is about, and which tightening the deviation avoids.

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
prismatic/            the mesh-to-solid app, on its own
  prismatic.js        the faces found, fitted, and rebuilt
  step.js             those faces written out as a STEP solid
  viewer.js           its viewport
  app.js              its UI
android/              the WebView wrapper
```
