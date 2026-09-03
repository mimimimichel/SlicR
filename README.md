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
node test-ui-android.js          # and the bridge the Android app saves across
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

It does not stop at flat faces, because a part does not. A bore arrives as
thirty-two little planes, and left at that it leaves as thirty-two little planes
— faces nobody can fillet, a diameter nobody can change. So the faces are looked
at again in groups: neighbours are added one at a time while a single plane,
cylinder, cone, sphere or torus still passes through all of them, and a group
that ends up with one becomes the single face that surface makes. The ring of
thirty-two segments around the end of it becomes one circle the same way. A
plate with a hole drilled through it goes from 38 faces and 108 edges to
**7 faces and 14 edges**; a plain cylinder, from 66 faces to three and two
edges, both of them circles. A doughnut of 9,216 triangles comes back as **one
toroidal surface**, and the volume it encloses is nearer the doughnut that was
drawn than the mesh of it was.

That the plane is on that list matters more than it reads. A patch that is
nearly flat fits a cylinder of radius a hundred, a cone of half angle eighty-six
degrees and a doughnut of major radius two hundred and sixty just as well as it
fits its own plane, and every one of those is a plane written by somebody who did
not notice. Asked as a candidate alongside the rest, and preferred wherever it
holds, the plane wins those — and it is also what lets the gauge simplify a wall
that arrived as two hundred facets, since nothing else here would.

A ball is the awkward one, because nothing bounds it and a face has to be
bounded by something. It gets cut in half the way a modeller would: one point
on the equator, one circular edge through it, and two faces that share it. A
doughnut is cut at both of its equators, which leaves two halves each bounded by
a wide circle and a circle round the hole.

Nothing is taken on trust. Every fit is measured against every corner of the
group *and the middle of every face in it*, and dropped if it is worse than the
tolerance you set — which is what keeps a twelve-sided hole a twelve-sided hole,
and keeps a square post from becoming the cylinder its four faces are, as it
happens, all tangent to.

**The gauge** is what you actually touch. One slider from *faithful* to
*simple*, reading out in millimetres and degrees and in what it came to — "0.14
mm · 3.1° · 8 planes, 1 cylinder" — and rebuilding when you let go, so the
simplification is something you watch rather than something you are told about.
What it means is a proportion of the part, so the same setting is sensible on a
five-millimetre bead and on a three-hundred-millimetre bracket.

It drives two tolerances, and they are not the same tolerance. How far the
**rebuild** may move the mesh is a rewrite of the triangles themselves: open
that up and faces reach across features, corners are flung onto crossings
nowhere near where they were, and the conversion refuses because the volume no
longer matches. It stays modest. How far a **recognised surface** may sit off
the facets it replaces is a different question — a cylinder put back where a
hundred little planes were is not a rewrite, it is the mesh's own surface named
— and naming it generously is exactly what somebody pushing a slider marked
*simple* is asking for. That one runs out to a percent of the part. On a part
modelled by hand it is the difference between a thousand faces and fifty, and
tying the two together was for a long time the single worst thing in here.

How far it can reach is set by the mesh, not by the part, and that is worth
saying plainly because it is where the gauge used to be useless. A tessellated
curve is a polygon, and the surface it stands for passes outside it: calling the
polygon a cylinder moves the surface out to where the arc is. That price —
`(c/2)·tan(θ/4)` for a chord of `c` and a fold of `θ` — is a property of the
mesh. A doughnut in twenty thousand triangles asks seven thousandths of a
millimetre for it; the same shape a modeller left in twenty-four sides asks a
quarter of one, thirty times as much on a part three times the size. Below that
price nothing can be recognised however hard the gauge is pushed. So it is
measured when the file is opened, shown in the panel as **Curves cost at
least**, and the top of the gauge's travel is whichever is further: a percent of
the part, or four times that price. A 624-triangle turned part comes back as
**six faces** — two cylinders, a torus, a ball and two ends — where before the
gauge could not reach far enough to find any of them.

Once the surfaces are known the corners are put back on them, the same way the
flat rebuild puts them on the crossings of their planes: a corner belongs to
every face that meets there, and after a ring of facets has become one cylinder
it has to be on the cylinder. Otherwise the file says the edge of a face is
somewhere the face is not, which is what a modeller trips over and why a body
will not stitch.

The screen shows the same thing. The triangles are moved onto the surfaces they
were recognised as, and — this is what actually makes it look like the answer —
shaded with those surfaces' own normals rather than the facets'. A cylinder
found in twenty-four sides has every corner on the cylinder already, so nothing
moves and it would still be drawn as a two-dozen-sided prism; shaded from the
surface it comes out round, which is what the file says it is. Corners between
two faces stay crisp, because a triangle soup keeps its own copy of each corner
and each copy carries its own face's normal. And a corner is never moved further
than the tolerance that put the surface there, nor at all if the move would turn
a sliver inside out — done carelessly this is worse than not doing it, and for
one version it was: a few hundred spikes through the surface instead of a part.

It matters more than it sounds. A tolerance tighter than a mesh's own facets
means nothing can be recognised — a ball tessellated in 32 segments is 0.08 mm
away from being a ball, so at 0.05 mm it stays 976 planes, and at the edge of
the tolerance it comes apart into pieces of ball, which is worse. The honest
framing is the one on the slider: a coarsely tessellated ball is itself a poor
copy of a ball, so simplifying it usually lands *closer* to what was drawn.

Out comes **STEP**, which is the point of it. A mesh is a bag of triangles that
every program opening it has to guess at; a STEP file says here is a point, here
is the edge between two points, here is the plane, here is the face those edges
bound, and here is the closed shell they make. Fusion opens that as a solid
body — faces you can click, fillet, sketch on and cut — so the part is editable
again rather than merely printable. STL comes out too, for printing.

Writing that file is not a second conversion: the faces, their surfaces and
their loops all fall out of the rebuild and the recognition already. What takes the care is that the edges
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

It runs on a phone or a tablet too: `prismatic/android/` is a WebView shell
around the same page, and its APK asks for **no permissions at all**. A mesh
comes in through the system file picker, the STEP file goes back out through the
storage picker, and nothing in between wants the network — a part you are
converting is nobody's business but yours.

```bash
cd prismatic/android
echo "sdk.dir=/path/to/Android/sdk" > local.properties
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

A file cannot cross into a WebView or back out of one as a blob, so both
directions go in pieces with the bytes counted on each side; `test-ui-android.js`
drives that against a stand-in for the native side — including a piece dropped
mid-transfer — and reads the STEP that comes out the far end back as a solid.

It is deliberately timid about what it will do to a part. Each rebuilt face is
measured against the facets it replaces, and the finished body against the
volume and the seams of the one it came from; what does not add up comes back
untouched with the reason. A mesh that was never prismatic — a scan, a sculpt —
is named as one before you press anything.

`test-step.js` reads the written file back knowing nothing about the code that
wrote it — its own part 21 parser, then the questions a solid modeller asks. Is
every reference resolved, is every edge used exactly twice and in opposite
directions, does every loop close, does every corner lie on the surface its face
claims. And then the one that catches whatever the others missed: the faces are
built back into a mesh from nothing but what the file says — circles sampled
round, cylinders walked over, each face triangulated in its own surface — and
that mesh is weighed. For a 20 x 30 x 10 box it comes to 6000.000 mm3, and for
the plate with the six millimetre bore, short by exactly the bore.

What is not there is a CAD kernel, and it shows at the edges. Planes,
cylinders, cones, spheres and tori are recognised — which covers a doughnut, a
turned bead and most of a fillet — but a swept or lofted surface is not, and
comes through as the band of flat faces it arrived as, faceted to the deviation
you set. Where two surfaces meet at a shallow angle the corner between them is
poorly pinned down, and at the loose end of the gauge a few of those stay a
tenth of a millimetre off the faces they belong to; the app reports the worst of
them rather than hiding it.

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
  primitives.js       fitting a plane, cylinder, cone, sphere or torus to them
  solid.js            those groups made into faces, and the edges they share
  step.js             the whole of it written out as a STEP solid
  viewer.js           its viewport
  app.js              its UI
  android.js          the file bridge, when it is running inside the app
  android/            its own WebView wrapper, asking for no permissions
android/              the WebView wrapper
```
