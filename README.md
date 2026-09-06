# Create-AR — 3D Model Converter

Upload a 3D model, pick a target format, get it back converted — with a live 3D
preview of the result in the browser, and an Analysis tab that pulls a model
apart into an exploded view, names every part, and saves it back out with the
names you gave them.

Conversion is done by a **headless Blender** process on the machine running the
backend. CAD formats (STEP/IGES) are tessellated with **OpenCASCADE** first,
because Blender has no CAD kernel of its own. Archives are unpacked and the
model inside is found automatically, so a zipped OBJ arrives with its materials
intact.

This is the `Convert` stage of the larger Create-AR Studio pipeline.

![React](https://img.shields.io/badge/React-18-61dafb)
![FastAPI](https://img.shields.io/badge/FastAPI-0.141-009688)
![Blender](https://img.shields.io/badge/Blender-5.2_LTS-f5792a)
![Tests](https://img.shields.io/badge/tests-149_passing-3ecf8e)

---

## Formats

|  | Input | Output | Engine |
|---|:--:|:--:|---|
| **GLB** / glTF | ✅ | ✅ | Blender |
| **USDZ**, USDC, USDA, USD | ✅ | ✅ | Blender |
| **FBX** | ✅ | ✅ | Blender |
| **OBJ** | ✅ | ✅ | Blender |
| STL | ✅ | ✅ | Blender |
| PLY | ✅ | ✅ | Blender |
| Alembic (`.abc`) | ✅ | ✅ | Blender |
| `.blend` | ✅ | — | Blender |
| **STEP** (`.step`, `.stp`) | ✅ | — | OpenCASCADE → Blender |
| **IGES** (`.iges`, `.igs`) | ✅ | — | OpenCASCADE → Blender |
| **Archives** — `.zip`, `.7z`, `.tar(.gz/.bz2/.xz)` | ✅ | — | unpacked, then as above |

CAD and archives are **input-only** — there is no path back from a mesh to
parametric CAD, and the output is a model rather than a bundle.

> **Collada (`.dae`) is not supported.** Blender removed its Collada importer
> and exporter in the 5.x series, so there is no operator to drive.
> [`docs/FORMATS.md`](docs/FORMATS.md) records what each engine actually
> provides, verified by introspection rather than read from documentation.

## How it works

```
upload ──▶ [archive?] ──▶ unpack, locate model ──┐
                                                 │
           [STEP/IGES?] ──▶ OpenCASCADE ──▶ .glb ─┤
                                                 ▼
                    headless Blender (import → transform → export)
                                                 │
                              ┌──────────────────┴──────────────────┐
                              ▼                                     ▼
                       target format                          preview.glb
                    (zipped if multi-file)                  (three.js viewer)
```

The Blender step runs as a subprocess against
[`backend/app/blender_job.py`](backend/app/blender_job.py), which reports
progress back over stdout as `@@`-prefixed JSON lines. Jobs are held in memory
and executed on a small thread pool.

Three details that matter in practice:

- **USD/USDZ is exported Y-up.** ARKit and Quick Look require it; Blender
  authors Z-up. Getting this wrong is the usual reason a model lies on its side
  in AR.
- **Broken texture paths are repaired.** Marketplace bundles routinely ship an
  `.mtl` full of the author's own absolute paths (`map_Kd C:/Users/bob/x.png`)
  while the images sit in a sibling `textures/` folder. Missing images are
  rebound by *exact filename*, so a wrong texture is never substituted.
- **Archive layout is not assumed.** The container is identified by magic bytes
  rather than extension, the model is found anywhere in the tree, and nested
  archives are opened recursively — including mixed `.zip` → `.tar.gz` → `.zip`
  chains. Every candidate is reported and the pick can be overridden.

---

## Exploded view and part names

Any preview can be taken apart. **Separate parts** in the top-right corner of
the viewer opens a slider that moves every part outward from the centre of the
assembly, proportionally to how far off-centre it already sits — so the
arrangement stays recognisable instead of flying into an even starburst. Closing
the panel puts the model back together.

The **Analysis** tab is built around that view. Loading a model spans the top of
the tab; underneath, the parts and the editor take the left and the viewer takes
the right, which is the half you work in. Drop a model in and it goes straight
to the exploded viewer, with every part listed beside it. Click a
part — in the viewer or in the list — and that one is named on the model and
outlined, with its row scrolled into view; click the background to drop the
selection. Only the selected part is labelled, because a real assembly has
hundreds of parts and naming them all at once buries the model (there is a
checkbox for it anyway, for small models). Edit a name in the list and the
label follows it. Pick a format, press **Save as**, and the model is written out
with the new names. Anything the converter can read works, so an FBX, a STEP
assembly or a zipped OBJ can all be taken apart and relabelled.

Saving does not re-upload: the server still has the model from the analysis
pass, so only the names travel. Names are applied to the Blender objects between
import and export, which is what glTF nodes, USD prims, FBX objects and OBJ
groups are all written from. **STL and PLY store a single unnamed mesh**, so
names cannot survive a save to those; the UI says so before you press the
button. (OBJ has no quoting, so `Top Cover` is written as `Top_Cover`.)

Three details worth knowing:

- **Parts are the ones the model was authored with.** The viewer descends past
  wrapper nodes to the level that actually holds more than one object. A model
  exported as a single merged mesh has no parts to separate, and says so rather
  than pretending otherwise.
- **Parts sitting at the centre still come out.** A core inside a housing has no
  outward direction of its own and would stay buried however far the slider goes,
  so anything nearer the centre than its own size is given a direction from an
  evenly spread set.

- **Names come from the model, not from the viewer.** They are the object names
  the exporter wrote, so what you rename is the thing the next tool downstream
  will show. The outline is drawn without depth testing, so a part selected
  from the list is still visible when it sits inside another one.

Separation is applied in the browser, to the preview GLB, and is only a way of
looking at the model — it never moves anything in the file you download. Edits
made in the panel below the list, on the other hand, do.

## Naming parts with a vision model

`Mesh_014`, `Cube.003`, `polySurface27` — most assemblies arrive with names that
say nothing. **Name parts with AI**, above the parts list, hands every part to an
Azure OpenAI vision deployment and writes back what it says they are. The names
land in the list as they arrive, each row keeps its own undo, and **Reset names**
still puts the lot back; a named part is a rename like any other, so nothing new
happens at save time.

The pictures are taken in the browser. The model is already loaded in WebGL, so
each part is framed and shot offscreen in a few milliseconds, where a second
Blender pass would cost a process launch per part. Each part gets up to two:

- **On its own**, framed tight against a plain backdrop, wearing its own
  materials.
- **In the assembly**, the same fixed view every time, with that one part lit
  orange and everything else ghosted. This is the one that earns its keep — a
  short cylinder is a spacer or a wheel hub depending entirely on what it sits
  in, and the shape alone will not say. It roughly doubles the image cost, and
  can be turned off.

Only the renders and the file's own name are sent; the model itself never leaves
the machine it was uploaded to.

### One part per request, or several

Both, switched in **Settings**.

- **Several parts per request** (the default, 8 at a time) is cheaper and much
  faster, and it lets the model tell siblings apart: shown four brackets
  together it will say *Left Front Bracket* rather than *Bracket* four times.
- **One part per request** gives each part the model's whole attention. Worth it
  for a small model of unusual parts; on a 200-part assembly it is 200 round
  trips.

Either way the parts are cut into chunks and a small pool of requests — three by
default — works through them in parallel, and each request is told which names
have already been handed out so it does not repeat them. A chunk that fails ends
the run and reports why, keeping whatever was already named.

### Every name comes out unique

Telling the model what has already been used is a hint, not a guarantee, and it
should not be one: four identical brackets *are* four brackets, and two chunks in
flight at once cannot see each other's answers. So any name that ends up on more
than one part is numbered — `Bracket #1` through `Bracket #4` — while a name only
one part holds is left exactly as it came. Numbering follows the part order in
the list, not the order the replies arrived in, and matching ignores case.

The whole set is worked out afresh as each chunk lands, because a duplicate only
becomes visible when the second part arrives: by then the first is already in the
list under its plain name, and gets numbered after the fact.

### Providers

Four, chosen on the settings page:

| | What it needs |
|---|---|
| **Azure OpenAI** | Endpoint, key, deployment name, API version. The deployment has to be one that accepts images. |
| **OpenAI** | An OpenAI key and a model — `gpt-4o` by default. |
| **Anthropic** | An Anthropic key and a model — `claude-opus-5` by default. Every Claude model reads images. |
| **OpenAI-compatible URL** | A base URL and a model name, for anything else speaking the same API: a local llama.cpp or vLLM server, a gateway, a router. The key is optional, because local servers usually want none. |

Each keeps its own key, so trying Claude for an afternoon does not cost you the
Azure key you had typed in, and a green dot on the settings page marks every
provider a key is held for. The three OpenAI-shaped providers are asked for a
JSON object and given the reply's shape in the prompt; Anthropic is handed a
JSON schema to enforce, and its refusals are reported rather than parsed as a
name.

**Not every OpenAI-shaped model takes the same parameters.** The o-series and
GPT-5 renamed `max_tokens` to `max_completion_tokens` and will not have
`temperature` set at all, while DeepSeek and the other compatible servers know
only the older spelling. Which applies cannot be read off the model's name — an
Azure deployment is called whatever its owner called it, and a compatible
endpoint may be serving anything — so it is not guessed at. The first request
is sent as normal, and a refusal that names the parameter it will not take is
retried with that one changed and the answer remembered for the rest of the
run. A refusal about anything else — a bad key, a model that does not
exist — is reported as it stands rather than retried.

### Settings

The **gear** in the top-right corner opens them — provider and its credentials,
one-per-request or batched, batch size, how many requests run at once, whether
to send the second picture, and the instructions the model is given. They are
saved on the server under `CONVERTER_DATA_DIR` (git-ignored, the same directory
the jobs live in), so they survive a restart and never reach the repository.

An API key is write-only from the browser: the server never sends one back, only
which providers it holds a key for, so saving with a key field blank keeps the
stored key and forgetting one is its own button. A blank key field is therefore
not an empty setting — the dot beside a provider and the field's placeholder are
how a stored key shows itself, since showing the key would undo the reason it is
only ever written.

### Where it all lives, and what is encrypted

Everything stays on the machine running the backend. `settings.json` sits in the
data directory, which is git-ignored *and* listed in `.dockerignore`, so it
reaches neither the repository nor an image. Nothing is sent anywhere else: the
keys are read back only to authenticate the request to whichever provider you
picked.

The keys in that file are **encrypted** rather than written in the clear —
Fernet (AES-128-CBC with an HMAC), one sealed value per key, marked `enc:v1:`.
That is what stops a copy of the file from being a copy of the key: a backup, a
synced folder, a container built with the data directory in it, a
`cat settings.json` pasted into a bug report.

Be clear about what it does *not* do. The master key is written beside the
settings as `secret.key` with owner-only permissions, because the app has to
start unattended, so anyone who can already read the data directory can read
both. To close that gap, put the master key somewhere else:

```bash
CONVERTER_SECRET_KEY="<a Fernet key>"
```

With that set, nothing on disk decrypts on its own — hand it in from a real
secret store, a systemd credential or a Docker secret, and no key file is
written at all. Generate one with:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

A settings file written before the keys were encrypted still loads, and is
sealed the first time it is read rather than waiting for someone to press Save.
A key that will not decrypt — a data directory copied without its key, a rotated
master key — reads as *absent* rather than raising: the page then shows that
provider as having no key, which is both true and fixable by typing it again.

On a fresh install the Azure fields are seeded from `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` and `AZURE_OPENAI_API_VERSION`,
so a container can be configured without anyone opening the page; a value typed
in wins from then on. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are deliberately
**not** read. They name no particular application and are set machine-wide by
editors, shell profiles and other agents, so adopting one would write a key the
user never intended for this app into `settings.json` on the first save, and
show the app as ready to spend against it.

The instructions are yours to rewrite. The reply format is not in them — it is
added to every request separately, so editing them cannot break the naming.

## What each part is, and the bundle that carries it

A model file has nowhere to say what a part is *for*. glTF, USD and FBX all
carry names and geometry and stop there. So the descriptions travel beside the
model, in a `parts.json`, and the two are zipped together.

With **Describe each part** on in Settings, a naming run also asks what each part
is, what it does, how it is used, its purpose, and whatever else applies — the
labels are the model's own choice, not a fixed schema, because what is worth
saying about a bearing is not what is worth saying about a wiring loom. With the
toggle off a run only renames, and costs a fraction as much.

Clicking a part fills both corners of the viewer: what it is on the left, and the
part **on its own** on the right. A selection box around a trim piece on a whole
car says where the part is and almost nothing about what it looks like, so the
right-hand panel renders that one part alone, framed tight. It shares its
renderer with the namer — the same offscreen setup that shoots the pictures the
model is asked about — opened on the first click rather than with the model, and
each render kept once taken.

The preview follows your edits, so it shows the model you are building rather
than the file you opened: restyle a part to glass and it turns to glass, rotate
or stretch it and it turns and stretches. Both the panel and the viewer compose
an edit through the same code, which is what keeps them agreeing with each other
and with the exporter. A *move* is the one edit it cannot show — the framing
follows the part, so sliding the part around leaves the picture unchanged.

### One part at a time

Clicking that preview — or the ⤢ on the part's row, or on its details
card — opens the part on its own, full size, which is where a single component
is worked on rather than a whole assembly:

- **A view you can turn.** Drag to orbit the part, scroll to zoom, arrow keys
  if you would rather not drag, and **Recentre** to go back to where it
  started. This moves *the camera*, not the part — turning the part itself is
  what the rotate sliders do, and that is an edit that gets saved. The angle is
  kept while you work on the same component, so nudging a slider does not snap
  the view back to the front; picking a different part starts square-on again.

- **Its name and its description, as fields.** The description is a list of
  label/text pairs, added and dropped one at a time, because that is the shape
  the document stores and the shape the model answers in. Both are a draft until
  **Save name & description**, and the dialog says *Unsaved* while they differ
  from the part.
- **Describe with AI** points the namer at this one part instead of the model.
  It renders the part, sends it with how many parts the model has and what the
  others are called, and writes the answer *into the draft* — so a generated
  name and description are edited and saved like any typed ones. Correcting one
  part costs one request, not another run over the assembly.
- **The same move, rotate, scale and restyling sliders** as the panel under the
  list — including opacity — applied live, with the view beside them redrawing
  as you drag.
- **Delete part**, which leaves the component out of the model you save.

Deleting is a mark, not a cut. The part is hidden in the viewer, struck through
in the list and left out of `parts.json`, but it stays in the file you opened
and in the list — **Restore** on its row, or **Restore all** above the list,
puts it back, and its name, description and edits are all still on it when it
returns. Only on save does the object actually go, along with everything
parented under it; the names and edits belonging to a deleted part are dropped
from the request rather than sent to land on nothing. A save that would remove
every part fails instead of writing an empty model.

### Two kinds of export

| | What you get |
|---|---|
| **Model only** | The converted file, as before. |
| **Model + details** | A ZIP holding the converted file *and* `parts.json`. |

The document names its own format at the top:

```json
{
  "format": "create-ar.parts",
  "version": 1,
  "model": { "file": "bike.glb", "sourceFile": "bike.step", "parts": 2 },
  "parts": [
    {
      "index": 0,
      "originalName": "Mesh_014",
      "name": "Front Wheel Hub",
      "details": {
        "What it is": "...",
        "Material": "...",
        "What usually goes wrong": "..."
      }
    }
  ]
}
```

`details` is an ordered map of label to text and nothing more is assumed about
it — the viewer and the export both just walk whatever is there, so a model that
volunteers a useful heading nobody thought of keeps it.

### Opening a bundle again

Drop that ZIP back in and the app recognises it. The `format` marker is the whole
point: plenty of pipelines write a file called `parts.json`, and without a marker
one of those would be read as ours. The document has to be ours *and* have usable
parts in it, or it is ignored and the model converts as any other archive would.

Parts are matched by name first — the model inside a bundle was written with the
names already applied, so a part's name in the file usually *is* the document's
`name` — then by `originalName`, which catches a bundle whose model went out to a
format that cannot carry names at all, and finally by index. Anything already
edited in the session is left alone.

## Marking parts

A click marks one part and drops whatever was marked before; **shift-click**
(or ctrl/cmd-click) adds one to the marks or takes it away again, in the viewer
and in the list alike. Clicking the background clears them. Every marked part is
outlined and named, and the count appears above the list.

Marks are what the editor works on, so several parts can be moved, turned,
resized or restyled in one go. A group turns and grows about the middle of the
group rather than each part spinning on its own spot, which is what picking a
set of parts and rotating them is meant to do.

## Editing a part

Marking a part also opens an editor under the list, for changing those parts
rather than the whole model: **move** it along each axis, **rotate** it, **scale**
it per axis, and restyle it. The viewer shows every change as it is made, and
pressing **Save as** writes them into the file along with the names. The same
editor sits in a part's own dialog, so one component can be worked on without
hunting for it in the list.

Restyling is a **material** preset with a **colour**, and three sliders:

| | |
|---|---|
| **Opaque** | How solid the part is, down to 5%. |
| **Rough** | How diffuse its finish is. |
| **Metal** | How metallic it is. |

Opacity is the one that needs no preset. Turning a housing see-through in order
to look at what is inside it should not throw away the housing's own finish, so
with the type left on *Keep original* the part keeps every material it was
authored with — textures included — and only fades. Rough and metal are the
opposite: they override the preset, and mean nothing without one. There is no
telling what the file shaded a part with, so there is no value they could hold
that would mean "leave it alone" — they are disabled until a preset is picked,
and seeded from it the moment one is.

A faded part stops writing depth in the viewer, so what is behind it shows
through rather than being clipped by draw order, and it is exported with glTF's
`alphaMode: BLEND`.

Everything in that panel can also be done by hand in the viewport. With a part
selected, **Move**, **Rotate** and **Scale** in the top-left corner attach a
gizmo to it, the way Blender or Unity would: drag a handle to edit the part,
drag anywhere else to orbit. The sliders and the gizmo are two views of the same
edit and follow each other live. Pressing the active mode again puts the gizmo
away. With several parts marked the gizmo sits at the middle of the group and
moves all of them together.

Orbit, pan and zoom are deliberately slower than three.js's defaults. A wheel
notch at the default speed crosses a good part of the model, which overshoots
constantly on an assembly you are picking single parts out of. **Reset view**,
beside the separation button, puts the camera back where it started when you
have turned yourself around.

The gizmo does not grab the part's own origin. Plenty of exports leave every
origin on the world origin -- a Sketchfab model wraps each part in an identity
node and offsets the geometry inside it -- so handles drawn there would sit
nowhere near the part you clicked, and every part's would sit in the same place.
An empty stands in at the part's visible centre instead, and its motion is
passed on. The handles are also drawn over the model rather than inside it: a
part is usually surrounded by the rest of the assembly, and a depth-tested gizmo
is buried the moment it is anchored on the part it edits.

- **An edit is a delta on the part's own transform**, so rotation and scale pivot
  on its origin and compose with whatever pose it was authored with. The axes are
  the viewer's, and moves are in the model's units. The slider reaches as far as
  the assembly is wide *measured in the space a move is applied in*, which is not
  the same as its size on screen: a model wrapped in a scaled root can be a
  hundredth of a unit across in the world and whole units across in its own.
- **The preview is not an approximation.** Blender's glTF exporter maps a node's
  local transform onto glTF's axes componentwise at any depth, so an edit made on
  screen is swizzled back onto Blender's axes and applied unchanged. What the
  viewer shows is what the saved file contains, to float precision.
- **A material replaces the part's own outright**, textures included. The five
  presets — plastic, metal, glass, matte and glowing — are Principled BSDF
  settings, and the colour you pick is converted from sRGB so the exported file
  is the shade you chose. Leave the type on *Keep original* to move a part
  without touching how it looks.
- **Fading a part copies what it was shaded with rather than replacing it.**
  Blender shares materials and mesh data between objects freely, so both are
  forked before the alpha is touched — otherwise fading one part would fade
  every part instanced from the same mesh. A part with no material of its own
  is given a plain one to fade, since there is nothing else to make see-through.
- **The panels over the viewer live inside it.** Filling the window turns the
  viewer into a fixed overlay across the whole page; anything left outside it
  would be buried underneath, which is why the part's details and its preview
  are children of the viewer rather than siblings.
- **The thumbnail is a still; the dialog is not.** A thumbnail that grabbed
  your drag would be worse than one that does not, and encoding a JPEG per
  frame is no way to run an orbit — so the dialog puts the offscreen renderer's
  own canvas straight into the page and drives its camera, while the thumbnail
  goes on asking it for pictures. Both share one studio type, so what you turn
  is composed by the same code as what you export.
- **STL and PLY keep neither names nor materials**, but the moves, rotations and
  scales still apply, because those are baked into the geometry that is written.
  OBJ needs every part to carry a material once any part is styled, so unstyled
  ones are given a plain grey; otherwise they would inherit the styled part's
  colour from the file's running `usemtl` state.
- **Part names are the file's own, not the viewer's.** three.js strips `[`, `]`,
  `.`, `:` and `/` out of glTF node names when it loads them, because its
  animation binding syntax reserves those characters. Maya and Sketchfab
  namespace their parts with a colon, so the sanitised name would match nothing
  on the way back; the viewer recovers the original from the loader's own node
  mapping and keys edits and renames by that.
- **A panel showing several parts shows what they agree on.** Any axis they
  differ on reads as none until you set it, and only the fields you actually
  move are written across -- otherwise nudging one slider would flatten every
  other value the parts did not happen to share.
- **An edit that names no part in the model is reported**, not passed over. If a
  save comes back with a warning naming parts, those names no longer match the
  objects the converter found, and nothing was applied to them. A deletion that
  names no part is reported the same way.
- **A deleted part is numbered afresh in the document.** `parts.json` describes
  the model it is written beside, so the indices skip nothing — they run over the
  parts that were actually exported.

Edits are cleared when a different model is analysed. **Reset** in the editor
returns the marked parts to how they arrived. Above the list, **Reset names**
and **Reset edits** each undo one kind for the whole model and leave the other
alone, so renaming a hundred parts is not lost to undoing a move. Each appears
only when there is something of its kind to undo, and neither touches what you
have marked.

## Animating parts

Everything above produces a still. The **Animation** card under the parts list
is off until you switch it on — a toggle in its head — because most models are
saved as they are, and a timeline nobody asked for would only take room from the
viewer. Switch it on and you get an animation to start in, the timeline under
the viewer, and a pose panel in the card.

An animation here is a **clip**: a name, a length in seconds, and keyframes.
There can be several — **Add animation** makes another, each with its own name
and length, and the one highlighted in the list is the one the timeline shows
and the viewer plays. A keyframe is a pose at a moment: where a part is, how it
is turned, how big it is. Between two keyframes the part travels in a straight
line; before the first and after the last it holds still.

Keying works the way animation tools have always worked once recording is on:

1. Mark a part — or several, or choose **Whole model** to move the assembly as
   one.
2. Drag the playhead to a moment.
3. Pose it, with the sliders in the card or the gizmo in the viewer. A keyframe
   lands at the playhead the moment you do; the timeline gets a diamond and the
   part gets a ◆ in the list.
4. Move the playhead and pose again.

Press play and it loops. **Add keyframe here** keys the pose the part is already
in without changing it, which is how you make something wait. A diamond can be
dragged to another moment or picked and deleted; **Remove key** in the pose
panel drops the one under the playhead. Clicking a lane's name marks that part.

Three things are worth knowing:

- **A keyframe is a change on top of the part's edit.** Nudge a bracket into
  place with the editor, then animate it, and the animation starts from where you
  put it. Rotations are kept in degrees rather than folded to a turn, so a key at
  360° is a full spin, not a part that never moves.
- **The whole model turns about its own centre.** The viewer measures it, and
  the file is told, so a spin keyed here is the same spin in the exported file
  — which gains one root node at that centre for every part to hang from.
- **Switching the toggle off keeps the clips** but saves the model without them,
  and says so. Analysing a different model clears them.

### Saving with animation

With keyframes to save, **Save as** offers only formats that can carry them:
GLB, glTF, USD in all its spellings, FBX and Alembic. OBJ, STL and PLY describe a
single still and would drop the animation without a word, so they are not on
the list while there is animation to lose. The server refuses them too, in case
something other than the UI asks.

The formats do not all carry the same thing:

| | What you get |
|---|---|
| **GLB / glTF** | One named clip per animation, which a viewer lets you pick and play. |
| **USD / USDZ**, **Alembic** | One timeline, the clips playing one after another. |
| **FBX** | One take, the clips playing one after another. |

Blender is handed the keyframes and bakes every clip to one pose per frame at
30 fps, using the same blend the viewer drew, so what plays in the file is what
played in the browser. glTF gets a clip per animation because the exporter
writes one animation per Blender action, and every part a clip moves is given a
slot in that clip's action. The others sample the scene frame by frame, and
have no notion of separate clips, so the clips are laid end to end on the
timeline for them, and a part sits still outside its own clips rather than
holding its last pose. Any animation the file arrived with is kept ahead of the
new clips rather than replaced. See [`docs/FORMATS.md`](docs/FORMATS.md).

---

## Quick start

### Docker (recommended)

The only supported way to get a known-good Blender without installing one:

```bash
docker build -t create-ar-converter .
```

```bash
docker run -d -p 8080:8080 -v converter-data:/data --name converter create-ar-converter
```

Open <http://localhost:8080>. Nothing else is required — the image contains
Blender, the API and the built frontend.

### Local development

Needs **Blender 4.2+** (developed against 5.2 LTS), **Python 3.11+** and
**Node 20.19+/22.12+**. Blender is found automatically in the standard install
locations, or set `BLENDER_PATH`.

```bash
python -m venv .venv && .venv/Scripts/activate    # Linux/macOS: source .venv/bin/activate
pip install -e "backend[dev]"
```

```bash
cd frontend && npm install && npm run dev
```

```bash
python -m uvicorn app.main:app --app-dir backend --port 8080 --reload
```

Open <http://localhost:5180>; the dev server proxies `/api` to port 8080. On
Windows `dev.ps1` starts both halves at once.

> Ports default to **8080** (API) and **5180** (UI), both moved off the
> conventional 8000/5173 which collide with almost every other project.
> Override with `CONVERTER_PORT` and `CONVERTER_UI_PORT`.
>
> Use `http://localhost:<port>`, not `127.0.0.1` — Vite binds the hostname,
> which on Windows does not always answer on the IPv4 loopback.

---

## Deployment strategy

### The constraint that shapes everything

**This service cannot run without Blender on the same host.** It shells out to a
real Blender binary per job. That rules out serverless and every
"bring-your-own-runtime" PaaS with a small image budget, and it sets the floor
for image size, memory and start-up time. Plan around it rather than against it.

Consequences:

| | |
|---|---|
| Image size | ~2.5 GB, most of it Blender. Not shrinkable in any meaningful way. |
| Cold start | Seconds, not milliseconds. Keep instances warm. |
| Per-job cost | One Blender process, CPU-bound, seconds to minutes. |
| Memory | Blender holds the whole scene. A 450k-triangle model needs ~1–2 GB *per concurrent job*. |
| GPU | Not needed. Conversion is import/export, not rendering. |

### Recommended: single container behind a reverse proxy

The [`Dockerfile`](Dockerfile) builds the SPA, downloads a pinned Blender from
blender.org, and serves everything from one process on port 8080. Blender is
downloaded rather than `apt install`ed deliberately: distro packages lag badly,
and this service depends on operators that only exist in 4.2+.

```yaml
# docker-compose.yml
services:
  converter:
    build: .
    ports: ["8080:8080"]
    volumes: [converter-data:/data]
    environment:
      CONVERTER_WORKERS: "2"
      CONVERTER_MAX_UPLOAD_MB: "512"
      CONVERTER_JOB_TIMEOUT: "900"
      CONVERTER_JOB_TTL: "86400"
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: "4", memory: 8G }
volumes:
  converter-data:
```

Put nginx (or your load balancer) in front, and **raise the two limits that
will otherwise bite**:

```nginx
location / {
    proxy_pass http://converter:8080;
    client_max_body_size 512m;   # must be >= CONVERTER_MAX_UPLOAD_MB
    proxy_read_timeout 900s;     # must be >= CONVERTER_JOB_TIMEOUT
    proxy_request_buffering off; # stream large uploads instead of spooling
}
```

The defaults in most proxies are 1 MB and 60 s. Both are far too small here, and
the resulting failures look like application bugs.

### Storage

Uploads, intermediates and results live under `CONVERTER_DATA_DIR` (`/data` in
the image). Mount a volume: without one, results vanish on restart and every
in-flight job is lost.

Finished jobs and their files are swept after `CONVERTER_JOB_TTL` (24 h by
default). Size the volume for peak concurrent jobs plus one TTL window of
results — a single 450k-triangle model produces roughly 30 MB of output, and the
source, the unpacked archive and the preview are all kept alongside it.

### Scaling

The job store is **in-process and in-memory**, and job files are on **local
disk**. That is a deliberate choice for a single-node service bound to a local
Blender install — a broker would add operational weight without buying anything
at this size — but it has a hard consequence:

> **Do not run more than one replica behind a round-robin load balancer.**
> A client that uploads to instance A and polls instance B gets a 404.

To scale vertically, raise `CONVERTER_WORKERS` (concurrent Blender processes)
and give the container proportional CPU and RAM. Two workers on 4 CPUs is a
sensible starting point.

To scale horizontally, three things have to change:

1. Move the job store out of process (Redis or Postgres) — `backend/app/jobs.py`
   is the only file that owns job state.
2. Move job files to shared object storage (S3 or equivalent).
3. Run conversion as a real queue worker rather than a thread pool.

Until then, prefer one larger instance over several small ones. Sticky sessions
are *not* a sufficient workaround, because results are also on that instance's
disk.

### Security posture

The service accepts untrusted archives and hands untrusted files to Blender.
What is already handled:

- Archive extraction **refuses rather than sanitises**: path traversal (`../`,
  absolute paths, drive letters, backslash separators), symlink and device
  entries, >4,000 entries, >2 GB expansion, and encrypted archives.
- Upload size is capped (`CONVERTER_MAX_UPLOAD_MB`) and enforced while
  streaming, not after.
- Filenames are sanitised to a safe stem; the original never touches the
  filesystem path.
- Every Blender run is `--factory-startup`, killed after
  `CONVERTER_JOB_TIMEOUT`, and the container runs as a non-root user.

What is **not** handled, and should be before exposing this publicly:

- **No authentication or rate limiting.** Anyone who can reach it can spend your
  CPU. Put it behind your own auth, or on a private network.
- **Blender parses untrusted files in-process.** It is not a sandbox. For hostile
  input, isolate the container further (seccomp, read-only root, no network,
  dropped capabilities).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BLENDER_PATH` | auto-detected | Explicit path to the Blender executable. |
| `CONVERTER_DATA_DIR` | `backend/data` | Where uploads and results are written. |
| `CONVERTER_MAX_UPLOAD_MB` | `512` | Upload size limit. |
| `CONVERTER_JOB_TIMEOUT` | `600` | Seconds before a Blender run is killed. |
| `CONVERTER_WORKERS` | `2` | Concurrent Blender processes. |
| `CONVERTER_JOB_TTL` | `86400` | Seconds before finished jobs and files are swept. |
| `AZURE_OPENAI_ENDPOINT` | unset | Seeds the part namer's Azure fields on first run. |
| `AZURE_OPENAI_API_KEY` | unset | Likewise. Saved settings win from then on. |
| `AZURE_OPENAI_DEPLOYMENT` | unset | Must accept images. |
| `AZURE_OPENAI_API_VERSION` | `2024-10-21` | |

Keys for the other three providers are typed on the settings page; see
[Settings](#settings) for why `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are
not read from the environment.

Discovery deliberately skips the Windows `WindowsApps\blender.CMD` alias: it
shells out to the detached GUI launcher, which never returns output to a
headless caller. Candidates are validated by running `--version`.

### Health checks

`GET /api/health` returns `ok: false` when Blender is missing and
`cadSupport: false` when OpenCASCADE is unavailable. Use it as both the
readiness and liveness probe — a container whose Blender is broken should not
receive traffic.

```json
{"ok": true, "blenderPath": "/opt/blender/blender",
 "blenderVersion": "Blender 5.2.1 LTS", "cadSupport": true,
 "maxUploadBytes": 536870912}
```

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Blender path/version, CAD availability, upload limit. |
| `GET` | `/api/formats` | Capability matrix that drives the UI. |
| `POST` | `/api/convert` | multipart: `file`, `target`, `options` → `202` + job. |
| `GET` | `/api/jobs/{id}` | Status, progress, stats, log. |
| `POST` | `/api/jobs/{id}/reexport` | Convert the same upload again: `target`, `options`. |
| `GET` | `/api/jobs/{id}/download` | The converted file (or a zip). |
| `GET` | `/api/jobs/{id}/preview` | GLB used by the in-browser viewer. |
| `GET` | `/api/settings` | Part-naming settings. Never includes the API key. |
| `PUT` | `/api/settings` | Save them; `?clear_key=<provider>` forgets one stored key. |
| `POST` | `/api/name-parts` | Name one chunk of rendered parts. |

```bash
curl -F file=@part.stp -F target=.usdz \
     -F 'options={"center":"floor","scale":0.001}' \
     http://localhost:8080/api/convert
```

Conversion options: `scale`, `center` (`none`/`origin`/`floor`), `decimate`,
`triangulate`, `apply_modifiers`, `animations`, `draco` and `draco_level` 0-10
(GLB), `y_up` (USD/USDZ), `cad_tolerance` (STEP/IGES), `archive_entry` to pick a specific
model inside an archive, `renames` — a `{"old": "new"}` map of part names —
`edits`, a map of part name to `{"move": [x, y, z], "rotate": [x, y, z], "scale":
[x, y, z], "material": "metal", "color": "#ff2200", "opacity": 0.5,
"roughness": 0.8, "metalness": 0.2}`, and `remove`, a list of part names to drop
from the scene before anything else touches it. `opacity` applies with or
without a material; `roughness` and `metalness` default to the chosen preset's
own values when left out. `bundle` with
`part_details` writes `parts.json` beside the model and zips the two together. Both are applied between
import and export. Every edit field is a delta on the part's own local transform
in the viewer's glTF-style Y-up axes, not Blender's Z-up; rotations are in
degrees and scale is a multiplier per axis.

Compression options, all off by default:

| Option | Effect |
| --- | --- |
| `tri_budget` | A total triangle count to hit. Takes precedence over `decimate`: meshes of 64 triangles or fewer are left alone and the rest share one decimate ratio, so the reduction comes out of the parts that hold the triangles. |
| `texture_limit` | Longest edge a texture may keep, in pixels. `0` leaves images alone. |
| `texture_format` | `auto` (keep), `jpeg`, or `webp`. Images feeding an alpha socket or a Normal Map node keep their original format — JPEG has no alpha channel, and its blocking facets a normal map's gradients. The resolution cap still applies to them. |
| `texture_quality` | 1-100, used when re-encoding. |
| `merge` | `none`, `material` (one mesh per material), or `all`. Cuts mesh and draw-call count but loses the per-part names, so it is skipped with a warning on a model that carries `clips`. |
| `weld` | Merge-by-distance threshold in model units. `0` is off. |
| `clean` | Drop unused material slots and loose vertices/edges. Mostly a no-op on ordinary uploads — Blender's glTF, OBJ and STL importers already discard unreferenced vertices and materials — so it earns its keep on `.blend` input, which preserves whatever its author left in it. |

Textures are resized and re-encoded to files under the job's `work/_tex/`, then
the image datablocks are repointed at them. This matters because the OBJ, FBX
and USD exporters copy the image *file* rather than re-encoding it, so scaling
only in memory would export at the original resolution for those three.

`resultStats` and `sourceStats` both carry `images` and `texturePixels`
alongside the geometry counts, and the job reports `sourceSize` next to
`outputSize`, which is what the UI's before/after column is drawn from.

`clips` is a list of animations to key into the file, each `{"name": "Spin",
"duration": 3, "tracks": [...]}` where a track is `{"target": "Wheel", "keys":
[{"time": 0}, {"time": 1.5, "rotate": [0, 360, 0]}]}` — a key carries the same
`move`, `rotate` and `scale` deltas an edit does, laid on top of the edit. A
target of `""` is the whole model, and that track carries a `pivot` to turn it
about. Clips are only accepted for targets whose `can_animate` is true in
`/api/formats`; the rest answer `400`.

## Sample models

[`samples/`](samples/) holds one file per supported input format — an animated,
two-material Suzanne for the mesh formats and a real 60 × 40 × 8 mm CAD bracket
for STEP/IGES. Drag any of them onto the upload area.

## Tests

```bash
.venv/Scripts/python -m pytest backend/tests -q
```

149 tests: format and alias resolution, upload validation, filename
sanitisation, archive extraction safety (zip-slip, symlinks, entry floods,
decompression bombs), model discovery across container formats and nesting
depths, texture relinking, and real Blender conversions — STL to every headline
target, STEP → USDZ, zipped OBJ with materials, USDZ archive spec compliance,
scale/centre correctness, part renaming through a re-export, and animation —
one named glTF clip per animation, the whole-model root on its pivot, clips
reaching USD and FBX, and stills refusing them. Conversion tests skip
automatically when Blender is absent.

## Project layout

```
backend/app/
  blender_job.py   runs INSIDE Blender: the import/export operator tables
  archives.py      unpacking, extraction safety, model discovery
  converter.py     pipeline: CAD tessellation, subprocess, output packaging
  formats.py       single source of truth for supported formats
  jobs.py          in-memory job store + worker pool
  main.py          FastAPI routes
  settings.py      the naming settings, persisted in the data directory
  vault.py         sealing the API keys in that file, and what that protects
frontend/src/
  App.tsx          shell: health/capabilities and the two tabs
  useConversion.ts upload + job polling, shared by both tabs
  views/           ConvertView (format → options → result), AnalysisView
  usePartShot.ts   one part rendered alone, for the preview and the dialog
  animation.ts     clips and keyframes: the blend the viewer plays and Blender bakes
  player.ts        the clock a clip plays to, kept outside React
  components/      Dropzone, OptionsPanel, ModelViewer (three.js + explode),
                   PartEditor, PartPreview, PartDialog (one part, full size),
                   AnimEditor (pose at the playhead), Timeline
docs/FORMATS.md    what each engine actually provides, and why
```
