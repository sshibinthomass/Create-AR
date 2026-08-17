# Create-AR Studio — Plan

An authoring platform that turns **any uploaded 3D model + its documentation** into a
complete, data-driven **AR learning experience** (Explore / Fix / Assemble), like the
Titanom hackathon app (`titanom_hack_2026`) — but where everything that was hand-authored
for the IKEA Markus chair is **generated automatically** and reviewed by a human.

---

## 1. The core insight — what the hackathon app actually needs

The viewer app (`titanom_hack_2026`) is already model-agnostic at the *engine* level
(splitter, exploded view, puzzle, gestures, voice tutor). What made the Markus chair work
was **hand-authored content**:

| Hand-authored today (in `modes.js` / `main.js`) | How it was made for the Markus |
|---|---|
| `MODELS` registry entry (GLB path, split mode, real height) | Manual |
| `SEMANTIC_NAMES` — a name for each of 47 mesh parts | Visual inspection in Blender, part by part |
| `MARKUS_INFO` — per-part facts (LLM grounding) | Read from the official IKEA manual |
| `CONTENT[*].fix` — repair procedures with gesture verbs | Authored from manual + real part numbers |
| `CONTENT[*].assemble` — build order + recall prompts | Authored |
| `CONTENT[*].faults` — symptom → cause/fix knowledge | Authored |
| `knowledgeDigest` / `partInfoDigest` — tutor grounding | Derived from the above |

**Create-AR Studio is the factory for that table.** Its output is an **Experience
Package** — a self-contained bundle (optimized GLB + `manifest.json` + `content.json` +
RAG index reference) that a generalized viewer loads by URL/QR code. The package schema
is the contract between the two apps and the single most important design artifact.

```
┌─────────────────────────  CREATE-AR STUDIO (this repo)  ─────────────────────────┐
│                                                                                   │
│  Upload ─→ Convert ─→ Segment ─→ Identify ─→ Enrich ─→ Generate ─→ Review ─→ Publish
│  (FBX/OBJ/  (→ GLB,    (parts +   (vision     (PDFs,    (names,     (human    (package │
│  STEP/STL/   Draco)     adjacency) LLM +       links,    fix steps,  edits &    → CDN + │
│  DAE/GLB +              graph)     photos)     web       assembly,   approves)  QR)     │
│  PDFs/links)                                  search →   faults,                        │
│                                               RAG)       part info)                     │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────  VIEWER (generalized fork)  ────────────────────────┐
│  Loads a package by URL → Explore / Fix / Assemble in 3D + WebXR AR,             │
│  voice tutor answers grounded in the package's RAG index                          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Studio frontend | **React + TypeScript + Vite**, react-three-fiber + drei for the 3D review viewport | The studio is a real multi-screen app (wizard, tables, editors) — a framework earns its keep here, unlike the viewer |
| Viewer | **Fork of `titanom_hack_2026`** (plain three.js + Vite), made data-driven | The engine already works (splitter, puzzle, gestures, AR anchors, voice). Rewriting it burns weeks for nothing; generalizing it is days |
| Backend API | **Python + FastAPI** | Python owns the 3D/CAD/ML ecosystem needed below |
| Job workers | **Celery (or RQ) + Redis** | Conversion, rendering, and embedding are minutes-long jobs — must be async with progress reporting |
| 3D engine | **Blender headless (`bpy`) as the single backend 3D engine** — import (FBX/OBJ/DAE/STL/PLY/glTF), separate-by-loose-parts, merge/join fragments, **rename objects in place**, decimate, bake transforms, turntable renders (Eevee), glTF export. **CadQuery/OCP (OpenCascade)** only for STEP/IGES tessellation (Blender can't read CAD), then handed to the same Blender pipeline; **trimesh** for pure-math analysis (adjacency, signatures) | One tool does import→segment→rename→render→export, so part identity survives every stage in a single .blend working file instead of being re-derived per tool |
| Mesh optimization | **gltfpack (meshoptimizer)** + Draco | Web/AR needs small files; phone GPUs need low poly |
| Database | **PostgreSQL + pgvector** | One database for relational data AND embeddings — no second vector store to operate |
| Object storage | **S3-compatible (MinIO locally)** | Source files, GLBs, renders, packages |
| LLM (vision + generation) | **Claude** — `claude-sonnet-5` for pipeline volume, `claude-fable-5`/opus for the hard passes (assembly-order reasoning) | Vision part-ID, doc extraction, content generation, tutor answers |
| Embeddings | **voyage-3** (or `bge-m3` self-hosted fallback) | RAG over manuals/specs |
| Web search | Anthropic web search tool / Tavily API | Part enrichment beyond the uploaded docs |
| Doc parsing | **PyMuPDF** (text + images), **unstructured** fallback | IKEA-style manuals are mostly *diagrams* — page images go to the vision model, not just text |
| Deploy (dev) | **docker-compose**: api, worker, redis, postgres, minio, studio, viewer | One command to run everything |

---

## 3. Data model (Postgres)

```
projects        id, name, owner, created_at
assets          id, project_id, kind(source_model|document|link|photo), filename,
                mime, s3_key, url, status
models          id, project_id, source_asset_id, glb_key(s3), units, real_height_m,
                split_mode(group|component), bounds, tri_count, status
parts           id, model_id, stable_part_id (deterministic), mesh_index,
                canonical_name, display_names(jsonb i18n), category, material_guess,
                bbox, centroid, tri_count, confidence, status(auto|reviewed)
part_renders    id, part_id, angle, s3_key            -- turntable snapshots
part_photos     id, part_id, s3_key                   -- user-captured real photos
adjacency       model_id, part_a, part_b, contact_area -- assembly-graph edges
documents       id, project_id, asset_id, title, pages, status
chunks          id, document_id | part_id | model_id, text, page_ref,
                embedding vector(1024), source(pdf|web|generated|manual_diagram)
content_packs   id, model_id, version, lang, body(jsonb)   -- fix/assemble/faults/info
publishes       id, model_id, content_pack_id, package_url, qr_key, published_at
jobs            id, project_id, type, state, progress, error, logs
```

Key rules carried over from the hackathon's hard-won lessons:

- **`stable_part_id` is deterministic** (hash of split strategy + mesh rank by triangle
  count + quantized bbox). The CLAUDE.md warns that re-exports shift indices — here the
  pipeline re-runs the split and re-maps by geometry signature instead of index.
- **`canonical_name` is always English** and is the matching key everywhere; display
  names are an i18n layer (exactly the viewer's `p.name` vs `partLabel()` split).
- Content references parts by **stable id + keyword match**, never raw mesh index.

---

## 4. The pipeline, stage by stage

### Stage A — Ingest & Convert
1. Upload wizard: drag-drop model file(s) + PDFs + paste URLs + basic metadata
   (product name, brand, real-world height — height drives AR life-size scale).
2. Format routing:
   - `glb/gltf` → passthrough validate
   - `fbx/obj/dae/stl/ply/blend` → Blender headless → glTF export
   - `step/stp/iges/igs` → OCP tessellation (per-solid → one mesh per solid, which
     gives *perfect* part segmentation for free — CAD is the best case) → glTF
3. Normalize: Y-up, meters, floor-contact origin (the viewer's `frameModel()` expects
   this), weld/dedupe, then `gltfpack` with Draco → target < 10 MB / < 300k tris,
   plus a full-res archival copy.
4. Job progress streamed to the UI (SSE/WebSocket); every stage writes to `jobs`.

### Stage B — Segment, merge & de-noise (Blender `bpy`)
**Source part names are treated as noise, never as signal.** Real exports arrive as
`Mesh_001`, `Cube.003`, `polySurface47`, `defaultMaterial` — the pipeline assumes every
name is meaningless and rebuilds part identity from geometry alone. Implemented as a
headless Blender pipeline (the hackathon splitter's logic, run server-side in `bpy`):

1. **Split** — auto-pick per model, reviewer can override:
   - **group mode**: one part per source object/mesh (Markus case, all CAD imports).
   - **component mode**: `bpy` separate-by-loose-parts (plus the quantized vertex-weld
     trick before separating, so seam normals don't fracture one physical piece) for
     fused single-mesh models (the office-chair/bed case).
2. **Merge fragments into physical parts** — the inverse problem, equally common: one
   physical part exported as 12 loose meshes (seat cushion + piping + stitching). Merge
   candidates by: (a) tiny volume relative to model, (b) bbox containment/overlap with a
   larger neighbor, (c) shared material, (d) contact area. Merged sets are `bpy` joined
   into one object; every merge is recorded and reversible in the review UI (split-back).
3. **Instance detection** — identical geometry signatures (quantized vertex/tri hash,
   scale-normalized) mark duplicates: 5 casters, 8 screws. Instances are *forced* to
   share one canonical name later, which is what makes them a semantic group the
   viewer's one-drop-places-all puzzle logic depends on. Symmetry pairs (mirrored
   left/right armrest) are detected the same way and named `X left` / `X right`.
4. **Adjacency graph** (trimesh, on the post-merge parts) — pairwise contact detection;
   new vs. the hackathon, and what makes *generated* assembly order physically sane.
5. The working `.blend` file is kept per model in S3 — every later stage (renders,
   renames, re-export) reopens it, so part identity is never re-derived from scratch.

### Stage C — Identify (the vision loop)
For each part, gather evidence and ask the vision model:
1. **Renders**: 4–6 turntable snapshots of the part isolated + 1 in-context shot
   (part highlighted amber inside the ghosted full model — exactly the viewer's
   isolate view, which is the strongest naming signal).
2. **User photos** (optional but powerful): a capture screen — same UX as the viewer's
   scan — where the creator photographs the *real* part; stored as `part_photos`.
3. **Manual diagrams**: candidate pages from the uploaded PDF (IKEA manuals are exploded
   diagrams with part callouts — vision can read the numbered callouts).
4. One Claude vision call per part (batched): product context + all evidence →
   structured JSON: `{canonical_name, category, function, material, part_number?,
   confidence}`. Low-confidence parts are flagged for the review queue.
5. **Cross-part pass**: a second call sees the *whole* naming table and fixes
   inconsistencies (5 identical casters must share a name — the viewer's group-placement
   logic depends on identical names forming a semantic group). Instance/symmetry groups
   from Stage B arrive pre-linked, so the model names the group once, not 5 times.
6. **Rename write-back**: approved canonical names are written into the Blender objects
   (`bpy` object/mesh names) and re-exported, so the published GLB's node names *are*
   the canonical part names — `Caster wheel`, not `Cube.003`. Any downstream tool
   (the viewer, Blender itself, a future editor) sees proper names with no lookup table
   required; the `stable_part_id` map in the manifest remains the machine key.

### Stage D — Enrich & RAG
1. PDFs → PyMuPDF: text chunks + page images; diagram-heavy pages get a vision-model
   caption pass ("page 7: attach gas cylinder to star base, 4x screw #112996").
2. Links → fetched, readability-extracted, chunked.
3. Web search per part with a part number or confident name → spec pages, replacement
   part listings, common-complaint threads → chunked with source URLs.
4. Everything embedded into `chunks` (pgvector), scoped by `model_id` and, where
   attributable, `part_id`.
5. Retrieval API: `POST /api/models/{id}/query {question, part_id?, k}` → used by
   generation (Stage E) and live by the viewer's tutor.

### Stage E — Generate the content pack
LLM generation, **always RAG-grounded, never from priors alone**, producing the exact
structures the viewer consumes:

- **Per-part info** (`MARKUS_INFO` equivalent): 2–3 grounded facts per part, with chunk
  citations kept in the DB for the reviewer.
- **Assembly sequence**: from the adjacency graph + manual-derived order → topologically
  valid steps, grouped semantically (all casters = one step), each with a
  **recall prompt that never names the part** (the viewer's prompt-before-label rule)
  and a post-placement reveal line.
- **Fix procedures**: for each fault, steps broken into **beats** — one sentence + parts
  + one verb from the viewer's fixed `FIX_ACTIONS` gesture vocabulary (remove, unscrew,
  lift_off, press_fit, tip_over, …). The verb whitelist ships in the package manifest so
  the schema is validated at generation time, not at runtime.
- **Faults list**: `{symptom, cause, fix}` mined from manuals + web (common complaints).
- **Grounding digests**: compact knowledge + part-info digests for tutor prompts.
- **i18n**: generate English first; translation pass per extra language (de) keeping
  canonical names and `match` keywords English — the viewer's one-language rule.

### Stage F — Review (human in the loop; this is a *product* screen, not a chore)
Three-pane studio editor:
- **3D viewport** (r3f): exploded slider, click-to-isolate — the reviewer sees exactly
  what the end user will see.
- **Part table**: name/category/confidence, inline edit, merge/split parts, reorder
  assembly groups by drag. Low-confidence items sorted to top.
- **Content editor**: fix steps with a "preview gesture" button (plays the verb on the
  part in the viewport), fault list, per-part facts with their source citations.
- Approve → content pack version is frozen.

### Stage G — Publish
- Bundle: `package.json` manifest (schema version, GLB URL, real height, split params,
  stable part map, verb whitelist, languages) + `content.json` (the pack) + GLB → S3,
  behind a public URL + **QR code**.
- The RAG index stays server-side; the manifest carries the query endpoint URL so the
  viewer's tutor asks live questions against it.
- Versioned; re-publish creates v2 and old QR keeps working (pinned or `latest` alias).

### Viewer generalization (fork of `titanom_hack_2026`)
The final work package — deliberately small:
1. Replace the hard-coded `MODELS` / `SEMANTIC_NAMES` / `CONTENT` / `MARKUS_INFO`
   modules with a **package loader** (`#/pkg/<id>/<mode>` route arm).
2. Tutor calls the Studio's RAG query endpoint for grounding instead of the baked
   digest (with the packaged digest as offline fallback).
3. Keep everything else: splitter, explode, puzzle, fixanim gestures, AR anchors,
   voice stack, i18n — they are already data-driven.

---

## 5. API surface (FastAPI)

```
POST /api/projects                          create project
POST /api/projects/{id}/assets              upload model/pdf/photo (multipart) or link
POST /api/models/{id}/pipeline/run          run/re-run stages (convert|segment|identify|enrich|generate)
GET  /api/jobs/{id}/events                  SSE progress
GET  /api/models/{id}/parts                 part table (+renders)
PATCH /api/parts/{id}                       rename/merge/recategorize
POST /api/parts/{id}/photos                 attach real photo → re-identify
GET/PUT /api/models/{id}/content            content pack draft
POST /api/models/{id}/query                 RAG query (also used live by viewer)
POST /api/models/{id}/publish               freeze + bundle + QR
GET  /pkg/{publish_id}/manifest.json        public package (viewer entry point)
```

---

## 6. Milestones

| Phase | Deliverable | Definition of done |
|---|---|---|
| **0. Scaffold** (½ day) | Monorepo `studio/` `api/` `worker/` `viewer/` `packages/schema/`, docker-compose, CI | `docker compose up` serves studio + api |
| **1. Ingest→GLB** (2–3 days) | Upload wizard, Blender/OCP conversion workers, optimized GLB, 3D preview | Upload an FBX and a STEP file → both preview in browser |
| **2. Segment** (2–3 days) | `bpy` splitter + fragment merge + instance detection + adjacency graph + part inspector UI | Markus GLB → 47 parts matching the hackathon split; a fragmented FBX collapses to sane physical parts |
| **3. Identify** (2–3 days) | Turntable renders, vision naming, photo capture, confidence queue, rename write-back into the GLB | ≥80% of Markus parts named correctly with no human input; exported GLB nodes carry the canonical names |
| **4. RAG** (2 days) | PDF/link/web ingestion, pgvector, query endpoint | "Why does the chair sink?" answered with manual citation |
| **5. Generate + Review** (3–4 days) | Content-pack generation + the three-pane review editor | Generated fix plan plays correct gestures in the viewport |
| **6. Publish + Viewer** (2–3 days) | Package bundling, QR, viewer package-loader fork | Phone scans QR → full Explore/Fix/Assemble in AR on a *newly uploaded* model, end to end |
| **7. Polish** | de i18n pass, voice in studio preview, telemetry (Langfuse pattern from the hackathon), auth | — |

**End-to-end demo script (the north star):** upload `office_chair.fbx` + its PDF manual
+ a product URL → watch the pipeline run → fix two part names in review → publish →
scan the QR with an Android phone → place the chair on the floor in AR → ask "why does
it sink?" → get a manual-grounded answer → rebuild it in the Assemble puzzle.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| CAD (STEP) conversion is gnarly | OCP tessellation is well-trodden; keep per-solid → per-part mapping (it's the *easy* case for segmentation); FBX via Blender is the reliable path for the rest |
| Fused single-mesh models segment badly | Component mode + tiny-fragment grouping + the review UI's merge/split — human fixes the tail, pipeline does the bulk |
| Source part names are garbage (`Mesh_001`, `Cube.003`) | Names are never trusted as signal — identity is rebuilt from geometry (Stage B), named by vision (Stage C), and the canonical names are written back into the exported GLB |
| Over-merging fuses two real parts into one | Every auto-merge is recorded and reversible; review UI has split-back; contact-area + material thresholds tuned conservative (prefer under-merge, which is a one-click join in review) |
| Vision misnames parts | In-context highlighted render (strongest signal), manual-diagram cross-reference, cross-part consistency pass, confidence-sorted review queue, real-photo re-identify |
| LLM invents facts/steps | Every generation call is RAG-grounded with citations stored; review UI shows sources; viewer tutor queries live RAG, not priors |
| Assembly order physically impossible | Adjacency graph constrains generation to topologically valid sequences; gesture-preview in review catches nonsense visually |
| Big models kill phone AR | gltfpack/Draco budget enforced in Stage A with a hard fail + decimation retry |
| Index drift on re-export (bit the hackathon) | Deterministic `stable_part_id` from geometry signature; re-map by signature, never by ordinal |

---

## 8. Repo layout

```
Create-AR/
├─ docker-compose.yml
├─ packages/schema/          # Experience Package JSON Schema — the studio↔viewer contract
├─ api/                      # FastAPI + Celery tasks (convert, segment, identify, enrich, generate, publish)
├─ worker/                   # Blender & OCP conversion images
├─ studio/                   # React studio (wizard, pipeline monitor, review editor)
└─ viewer/                   # generalized fork of titanom_hack_2026 (package loader)
```

Phase 0 starts with `packages/schema/` — the package schema is written **first**, and
both the generator and the viewer loader are built against it.
