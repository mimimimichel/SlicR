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

It moves **one** tolerance, and getting to one was most of the work. How far a
**recognised surface** may sit off the facets it replaces is the whole of the
simplification: a cylinder put back where a hundred little planes were is not a
rewrite of the mesh, it is the mesh's own surface named, and naming it
generously is exactly what somebody pushing a slider marked *simple* is asking
for. How far the **rebuild** may move the mesh is a different question with a
different answer — open that up and faces reach across features, corners are
flung onto crossings nowhere near where they were, and the conversion refuses
because the volume no longer matches. It is held still, at a thousandth of the
part, whatever the gauge says.

Moving both together was the last thing making the answer jerk about. Every
notch changed the mesh the recognition was then run on, so the count went 583,
then 1030, then 60 for reasons that had nothing to do with what was asked. Held
still, every part tried comes back monotone: more simplification, fewer faces,
every time.

**Or press *Find the best setting*** and it is measured rather than guessed. The
rebuild is done once — that is what makes this cheap — and the recognition is
run three times to survey the slider, then wherever the answer is still moving.

Each setting comes back with three numbers: how many faces, how many of them
are *named shapes* rather than flats, and how far the surfaces actually ended
up sitting off the mesh. That last one is not the tolerance. A tolerance is a
permission; this is the bill, and on a part that fits well it is a fraction of
what was allowed. The demo plate is asked for 0.030 mm and spends 0.016.

The settings are then walked from the faithful end, and a looser one is taken
over the one in hand when either **it removes a seventh of the faces that are
left**, or **it finds a shape without adding faces**. The second line is the
one that matters to somebody who then has to edit the thing. Twenty faces that
include four cylinders is a part; twenty flats in the same places is a picture
of one. A step that trades flats for a cylinder barely moves the count and is
worth taking every time — counting faces alone would refuse it.

Then it walks the winner *back*: it halves the distance to the setting below
and keeps going while the answer holds, so the gauge ends up on the tightest
setting that still gives what was chosen — 38 rather than 50 — which is
accuracy that costs nothing. Six builds, and the number it lands on is its own
rather than one of a handful of stops.

A box is six faces at every setting, so it is left at the faithful end and told
"this needs no simplifying at all". A plate with a bore stops at the cylinder
rather than being pushed on to gain nothing and lose accuracy. A rosary of
43,000 triangles goes all the way and comes back as sixty-one faces.

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
least**, and it sets the floor for the top of the gauge's travel.

The ceiling comes from the same measurement read the other way: the radius those
folds turn about, which is the size of the *features* rather than the size of
the part, and those are not the same thing at all. A rosary is sixty-four
millimetres across and made of beads four millimetres round; a percent of the
part is a sixth of a bead, and at that tolerance a bead is within reach of being
called a cylinder — which is what came back, ten beads turned into ten little
drums. An eighth of the smallest feature's radius is as far as the gauge goes.
So the top of its travel is four times what the mesh's faceting costs, or the
lesser of a percent of the part and an eighth of a feature, whichever is more. A 624-triangle turned part comes back as
**six faces** — two cylinders, a torus, a ball and two ends — where before the
gauge could not reach far enough to find any of them; a 43,000-triangle rosary
comes back as **sixty**, its ten beads ten round balls.

And then the faces that are not faces are taken out. On one reported part,
forty-two of fifty-nine faces carried three hundredths of one percent of the
surface between them — slivers a few square microns each, left where the rebuild
put a corner back on the crossing of two nearly parallel planes and it came out
folded, every one of them promoted to a face of its own with its own colour and
its own ring of edges. That is what turns a doughnut and three cylinders into a
mosaic. The measure of too small is the tolerance squared: a face smaller than
the square of the distance the surfaces are allowed to move is smaller than the
answer's own resolution and has nothing in it to describe, so it goes to
whichever neighbour it shares the most boundary with. **Fifty-nine faces to
seventeen**, and every one of the seventeen carries surface.

Once the surfaces are known the corners are put back on them, the same way the
flat rebuild puts them on the crossings of their planes: a corner belongs to
every face that meets there, and after a ring of facets has become one cylinder
it has to be on the cylinder. Otherwise the file says the edge of a face is
somewhere the face is not, which is what a modeller trips over and why a body
will not stitch.

The screen shows the same thing, and it has to show all of it: which face each
triangle ended up on is looked up by where the faces are rather than by asking
every triangle about every face, so a solid of twelve thousand faces is worked
out in sixty milliseconds. Giving up past a few hundred, as it used to, was
worse than slow — the edges of the solid went on being drawn over the colours of
the mesh underneath, one thing's boundaries on another thing's faces, which
looks exactly like patches of different colour with no edge between them.

The triangles are moved onto the surfaces they
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

**Where two faces meet, the edge between them is where their surfaces cross** —
worked out from the surfaces, not traced off the mesh. This is the difference
between a face that looks drawn and a face that looks decalqued, and it took a
while to see. Every boundary arrives as a staircase of facet edges, and fitting
a line or a circle *to the staircase* only works when the staircase is tidy:
where a plane cuts a doughnut the true answer is a circle, exactly, and the
staircase around it wanders far enough that no circle fitted to it holds. So
that boundary came back as a hundred and forty separate little lines. Asking the
two surfaces instead gives the circle to the last decimal. On the reported part,
**358 edges to 62**, nineteen of them circles.

Only the crossings with an answer in closed form are taken: two planes cross in
a line, and any two surfaces of revolution about the same axis cross in circles
about it — a plane square to a bore, a shoulder on a shaft, a fillet running
into a face, a ball seated in a socket. A plane *along* a bore crosses it in two
straight lines rather than a circle, and is left alone rather than lied about.
The point on the curve is not solved for case by case either; it is a point of
the boundary pulled onto both surfaces at once, which is the same solve that
seats every corner.

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

What is not there is a CAD kernel, and where it shows is in which crossings can
be worked out. Only the ones with an answer that is a line or a circle are —
which is every crossing a turned or machined part is made of, and not the rest.
Two cylinders at an angle cross in a quartic; a plane cutting a doughnut
obliquely likewise. Those boundaries keep the mesh's, cut into the fewest
straight runs that hold rather than one edge per facet.

Beyond that: Planes,
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
