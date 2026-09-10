# Graph Report - Create-AR  (2026-09-10)

## Corpus Check
- 68 files · ~107,463 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1291 nodes · 2838 edges · 66 communities (58 shown, 6 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 72 edges (avg confidence: 0.88)
- Token cost: 107,693 input · 20,226 output

## Community Hubs (Navigation)
- Parts & Animation Document
- Reasoning Naming Agent
- Archive Unpacking
- Part Facts & Agent Tests
- Frontend Animation Math
- Clip & Options Schemas
- Animation Generation
- Conversion Options UI
- App Shell & Model Viewer
- Frontend Build Dependencies
- Vision Naming Prompts
- Settings Store Tests
- API End-to-End Tests
- Vision Provider Clients
- Round-Trip Naming Tests
- Clip Editing Helpers
- Three.js Scene Assembly
- Part Edit & Restyle
- Blender Mesh Operations
- Settings Persistence
- Agent UI & Hooks
- Blender Discovery & Pipeline
- App TypeScript Config
- Fernet Key Vault
- Part Transform Editor
- Blender Import/Export Ops
- In-Process Job Store
- Ask Agent Design Plan
- Part Shot Capture
- Format Canonicalization
- CAD Tessellation & Packaging
- Format Capability Table
- Agent Naming Rationale
- Theme Contrast Check
- Texture Compression Tests
- Node TypeScript Config
- FastAPI App Surface
- Animation Playback Player
- Quaternion Parity Check
- Blender Material Shading
- GLB Inspection Helpers
- Scene Bounds & Transforms
- Triangle Budget Tests
- CAD Units & Axis Conventions
- Archive & Texture Safety
- Part Edits & Keyframe Baking
- Format Support Decisions
- Texture Relink Tests
- Fake Provider Doubles
- NLA Clip Arrangement
- Namer Settings Page
- Decimate to Triangle Target
- Merge & Removal Tests
- Sample Model Generator
- STEP Fixture Writer
- Part Graph Utilities
- Naming Provider Configuration
- Material Backfill
- Pose Sampling & Easing
- Naming Endpoint Guard
- Settings Test Fixtures
- Viewer Error Boundary
- TypeScript Project Refs
- Backend Package Metadata

## God Nodes (most connected - your core abstractions)
1. `run_job()` - 40 edges
2. `Settings` - 35 edges
3. `chair()` - 30 edges
4. `extract_model()` - 28 edges
5. `Options` - 25 edges
6. `configure()` - 24 edges
7. `NameRequest` - 23 edges
8. `build()` - 23 edges
9. `react` - 23 edges
10. `Session` - 22 edges

## Surprising Connections (you probably didn't know these)
- `rank() deterministic prefilter before spending a request` --semantically_similar_to--> `Skip parts under a percentage of the longest side`  [INFERRED] [semantically similar]
  docs/NEXT_ASK_AGENT.md → README.md
- `A question is untrusted input` --semantically_similar_to--> `Untrusted archive handling refuses rather than sanitises`  [INFERRED] [semantically similar]
  docs/NEXT_ASK_AGENT.md → README.md
- `Broken texture paths repaired by exact filename` --semantically_similar_to--> `Single-file OBJ upload loses its materials`  [INFERRED] [semantically similar]
  README.md → samples/README.md
- `Stateless one-round-trip design` --references--> `Reasoning naming agent`  [EXTRACTED]
  docs/NEXT_ASK_AGENT.md → README.md
- `Editing parts: move, rotate, scale, restyle` --references--> `Axis conventions per export target`  [INFERRED]
  README.md → docs/FORMATS.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The naming agent's reasoning loop** — readme_naming_agent, readme_assembly_identification_first, readme_neighbourhood_shots, readme_measurements_as_text, readme_look_again, readme_stop_and_ask, readme_artefact_detection, readme_identical_part_deduplication [EXTRACTED 1.00]
- **Untrusted archive ingestion pipeline** — readme_archive_unpacking, readme_extraction_safety, docs_formats_magic_byte_detection, docs_formats_model_discovery, docs_formats_safe_extract, docs_formats_texture_relinking [EXTRACTED 1.00]
- **Ask-the-model animation retrieval design** — docs_next_ask_agent_ask_endpoint, docs_next_ask_agent_stateless_design, docs_next_ask_agent_clip_meta_retrieval_surface, docs_next_ask_agent_rank_prefilter, docs_next_ask_agent_clip_merge_helper, readme_animation_generation [EXTRACTED 1.00]

## Communities (66 total, 6 thin omitted)

### Community 0 - "Parts & Animation Document"
Cohesion: 0.05
Nodes (79): animation_order(), AnimationDetail, build(), clean_animations(), clean_details(), _draws(), export_order(), find() (+71 more)

### Community 1 - "Reasoning Naming Agent"
Cohesion: 0.06
Nodes (71): AgentError, _artefacts(), Ask, _axes(), _body(), close(), _commit(), _dims() (+63 more)

### Community 2 - "Archive Unpacking"
Cohesion: 0.07
Nodes (68): ArchiveError, ArchiveResult, extract_model(), _extract_sevenzip(), find_models(), _is_junk(), Member, _nested_archives() (+60 more)

### Community 3 - "Part Facts & Agent Tests"
Cohesion: 0.08
Nodes (65): PartFacts, qualify(), One part, measured. No pixels -- this is the free half of the evidence., Tell identical parts apart by where each one sits. Four identical bolts really…, chair(), clean(), configure(), facts() (+57 more)

### Community 4 - "Frontend Animation Math"
Cohesion: 0.11
Nodes (43): agreed(), applyPose(), clearTrack(), conj(), DEFAULT_DURATION, DEFAULT_EASE, degrees(), isPosed() (+35 more)

### Community 5 - "Clip & Options Schemas"
Cohesion: 0.06
Nodes (33): Clip, ClipMeta, Keyframe, Options, PartEdit, Pose, BaseModel, One part's transform and material override, from the Analysis tab. (+25 more)

### Community 6 - "Animation Generation"
Cohesion: 0.08
Nodes (46): poseAbout(), rotateVec(), about(), ALL_WANTED, along(), at(), Axis, AXIS_NAME (+38 more)

### Community 7 - "Conversion Options UI"
Cohesion: 0.08
Nodes (37): AgentNamed, ConvertOptions, COUNT, DEFAULT_OPTIONS, Format, formatBytes(), formatCount(), formatPixels() (+29 more)

### Community 8 - "App Shell & Model Viewer"
Cohesion: 0.09
Nodes (34): Capabilities, getCapabilities(), getHealth(), getSettings(), Health, App(), NEXT, SAYS (+26 more)

### Community 9 - "Frontend Build Dependencies"
Cohesion: 0.06
Nodes (34): dependencies, react, react-dom, @react-three/drei, @react-three/fiber, three, devDependencies, @types/node (+26 more)

### Community 10 - "Vision Naming Prompts"
Cohesion: 0.12
Nodes (32): _blocks(), _budget(), instructions_for(), name_parts(), NameRequest, The shape a reply has to take. Anthropic is handed this to enforce; the OpenAI-…, The user turn: every part's pictures, then what to reply with. Only the image…, Pull the names -- and descriptions -- out of the reply. Only the ids this chunk… (+24 more)

### Community 11 - "Settings Store Tests"
Cohesion: 0.13
Nodes (25): load(), Read the saved settings, falling back to the environment and defaults. Keys…, configure(), The settings store and the part namer. The Azure call itself is stubbed: what…, The point of the file: nothing typed on the page is typed twice., A data directory copied without its key, or a rotated master key. Reporting the…, OPENAI_API_KEY and ANTHROPIC_API_KEY are set machine-wide by all sorts of…, test_a_chunk_may_not_be_empty_or_enormous() (+17 more)

### Community 12 - "API End-to-End Tests"
Cohesion: 0.09
Nodes (15): Strip any directory component and unsafe characters from an upload name., safe_stem(), _lift_from_blender_job(), parametrize, End-to-end tests. The conversion cases drive a real headless Blender., One function out of blender_job.py, without importing bpy. The animation block…, The baker has to match `poseAt` in the browser, or the saved file plays…, test_clips_reach_the_single_timeline_formats() (+7 more)

### Community 13 - "Vision Provider Clients"
Cohesion: 0.10
Nodes (27): _anthropic_image(), ask(), _ask_anthropic(), _ask_openai(), _clean(), entry_id(), _image(), NamingError (+19 more)

### Community 14 - "Round-Trip Naming Tests"
Cohesion: 0.18
Nodes (27): await_job(), glb_node_names(), A zipped OBJ+MTL must convert *with* materials -- that is the point of…, Maya and Sketchfab namespace their parts with a colon. three.js strips ``[ ] .…, OBJ's ``usemtl`` is a running state, so an unstyled part written after a styled…, run_job(), test_a_model_already_within_budget_is_left_alone(), test_an_edit_naming_no_part_is_reported_not_swallowed() (+19 more)

### Community 15 - "Clip Editing Helpers"
Cohesion: 0.14
Nodes (22): copyClip(), newClip(), pruneClips(), restAxes(), reverseClip(), unpivot(), downloadUrl(), isEdited() (+14 more)

### Community 16 - "Three.js Scene Assembly"
Cohesion: 0.09
Nodes (22): Assembly, buildParts(), CAMERA_START, GIZMOS, NO_EDITS, NO_HIDDEN, NO_LABELS, NO_SELECTION (+14 more)

### Community 17 - "Part Edit & Restyle"
Cohesion: 0.13
Nodes (18): isRestyled(), MATERIALS, displace(), Model(), poseNode(), readNode(), BLACK, buildMaterial() (+10 more)

### Community 18 - "Blender Mesh Operations"
Cohesion: 0.10
Nodes (23): apply_clean(), apply_decimate(), apply_merge(), apply_removals(), apply_renames(), apply_triangulate(), apply_weld(), compress_textures() (+15 more)

### Community 19 - "Settings Persistence"
Cohesion: 0.12
Nodes (16): ensure_dirs(), Save the settings page. The browser is never sent an API key, so it cannot send…, write_settings(), _from_env(), BaseModel, Persisted settings for the part namer. Everything typed on the settings page is…, What to ask for, by whatever name the chosen provider calls it., Does the *selected* provider have everything it needs? (+8 more)

### Community 20 - "Agent UI & Hooks"
Cohesion: 0.16
Nodes (17): AgentAsk, AgentStep, nameParts(), PartDetails, PartShotPayload, startAgent(), stepAgent(), stopAgent() (+9 more)

### Community 21 - "Blender Discovery & Pipeline"
Cohesion: 0.13
Nodes (16): _candidates(), find_blender(), _is_usable(), Runtime configuration and Blender discovery., Locate a *working* headless Blender executable. Result is cached., Sort key from the version in a Blender install path (e.g. 'Blender 5.2')., Every plausible Blender path, best first. Real installs are tried *before*…, A candidate counts only if it answers ``--version`` on stdout. (+8 more)

### Community 22 - "App TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+9 more)

### Community 23 - "Fernet Key Vault"
Cohesion: 0.18
Nodes (16): _fernet(), forget_cipher(), is_sealed(), key_location(), _master_key(), Path, Encrypting the API keys that settings.json holds. The settings file has to…, Where the master key is kept, or None when the environment supplies it. (+8 more)

### Community 24 - "Part Transform Editor"
Cohesion: 0.18
Nodes (13): atRest(), Keyframe, MaterialType, PartEdit, Pose, AXES, CHANNELS, Props (+5 more)

### Community 26 - "In-Process Job Store"
Cohesion: 0.21
Nodes (4): Job, JobStore, Path, Drop jobs (and their files) past the TTL. Returns how many went.

### Community 27 - "Ask Agent Design Plan"
Cohesion: 0.18
Nodes (16): POST /api/ask — question to answer plus clip, Clip merge helper, ClipMeta as the retrieval surface, Known ceiling: hinge turns about the part's own origin, rank() deterministic prefilter before spending a request, Stateless one-round-trip design, Animation as clips of keyframes, Generating animations from the model (+8 more)

### Community 28 - "Part Shot Capture"
Cohesion: 0.14
Nodes (4): PartFacts, ShotSpec, capturePartShots(), PartStudio

### Community 29 - "Format Canonicalization"
Cohesion: 0.20
Nodes (15): canonical(), is_supported_input(), is_supported_output(), Normalise an extension: lowercase, leading dot, aliases resolved., Why ``ext`` is refused and what to supply instead, if we recognise it., unsupported_note(), new_job_dir(), Allocate an id and its ``source/`` directory before the upload streams in. (+7 more)

### Community 30 - "CAD Tessellation & Packaging"
Cohesion: 0.22
Nodes (14): ConversionError, convert(), _package_outputs(), Path, RuntimeError, Zip the result when the exporter produced sidecars (.mtl, .bin, textures).…, Convert ``source`` into ``target_ext``, returning what to serve back., Raised with a message safe to show the user. (+6 more)

### Community 31 - "Format Capability Table"
Cohesion: 0.18
Nodes (13): animated_exts(), can_animate(), describe(), Format, input_exts(), output_exts(), The single source of truth for what this service can read and write.…, Every extension accepted for upload, aliases included. (+5 more)

### Community 32 - "Agent Naming Rationale"
Cohesion: 0.19
Nodes (14): ModelViewer must stay its own lazy chunk, Single-face artefacts never reach the model, Identify the assembly before naming any part, One part per request, or several, Exploded view and part separation, Identical parts identified once, The agent may ask to look again, Measurements travel as text (+6 more)

### Community 33 - "Theme Contrast Check"
Cohesion: 0.16
Nodes (10): channel(), css, dark, ds, GROUNDS, luminance(), PAIRS, ratio() (+2 more)

### Community 34 - "Texture Compression Tests"
Cohesion: 0.17
Nodes (13): _glb_image_sizes(), _jpeg_size(), _png(), A valid ``side``x``side`` RGB PNG, so a resolution cap has room to bite., A zipped OBJ whose one material points at a ``side``x``side`` texture., Pixel dimensions of every image embedded in a GLB., OBJ copies the texture file rather than re-encoding it, so the scaled and re-…, GLB to GLB is not a no-op now that the options can shrink the model -- it is… (+5 more)

### Community 35 - "Node TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, allowImportingTsExtensions, isolatedModules, lib, module, moduleDetection, moduleResolution, noEmit (+4 more)

### Community 36 - "FastAPI App Surface"
Cohesion: 0.17
Nodes (10): _flush_langfuse(), get_job(), list_jobs(), FastAPI surface for the converter., Traces are batched; without this the last few are lost on exit., Static files with a fallback to index.html. Each view of the UI has its own…, read_settings(), _Spa (+2 more)

### Community 38 - "Quaternion Parity Check"
Cohesion: 0.26
Nodes (8): compare(), degrees(), EDGE, quat(), refDegrees(), refQuat(), rotateVec(), same()

### Community 39 - "Blender Material Shading"
Cohesion: 0.22
Nodes (11): build_material(), fade_object(), hex_to_linear(), make_multiply_node(), #rrggbb' from a colour input -> the linear RGB Blender shades in. Browser…, Dial one material's opacity down, and let the exporter know it blends. Both…, Recolour one material without replacing it. The part keeps its own finish --…, A node multiplying one input colour by ``rgb``: ``(output, input)``. Blender… (+3 more)

### Community 40 - "GLB Inspection Helpers"
Cohesion: 0.29
Nodes (11): glb_animation(), glb_channel_values(), glb_doc(), glb_material(), glb_node(), The JSON chunk of a GLB, which is where names, transforms and materials land., The material on a node's first mesh primitive., Every sample of one channel, decoded from the binary chunk. (+3 more)

### Community 41 - "Scene Bounds & Transforms"
Cohesion: 0.20
Nodes (10): apply_center(), apply_scale(), mesh_objects(), Axis-aligned bounds of all renderable geometry, in world space., Count what the scene holds., Apply ``fn`` to every root object (children follow via parenting)., ``origin`` centres the bounding box; ``floor`` also drops it onto Z=0., scene_stats() (+2 more)

### Community 42 - "Triangle Budget Tests"
Cohesion: 0.22
Nodes (10): _dense_stl(), _glb_triangles(), A binary STL grid of ``rows * rows * 2`` triangles. The triangle budget…, Both knobs aim the same reduction, so sending both must not compound., Triangles the GLB actually carries, counted from its accessors., Simplify is a modifier, so with 'apply modifiers' off it never reaches the…, test_a_budget_overrides_the_percentage(), test_applying_modifiers_writes_the_reduction_into_the_file() (+2 more)

### Community 43 - "CAD Units & Axis Conventions"
Cohesion: 0.27
Nodes (10): Axis conventions per export target, CAD unit conversion: millimetres declared, metres emitted, cascadio B-rep tessellation, USDZ archive spec compliance, CAD input via OpenCASCADE tessellation, USD/USDZ exported Y-up, bracket.* CAD sample, The bracket looks tiny in the stats (+2 more)

### Community 44 - "Archive & Texture Safety"
Cohesion: 0.29
Nodes (10): Container detection by magic bytes, Model discovery inside archives, Multi-file outputs zipped before download, safe_extract refuses rather than sanitises, Texture relinking by exact filename, A question is untrusted input, Archive input: unpack and locate the model, Untrusted archive handling refuses rather than sanitises (+2 more)

### Community 45 - "Part Edits & Keyframe Baking"
Cohesion: 0.28
Nodes (9): apply_edits(), make_model_root(), Move, rotate, scale and restyle individual parts before export. Each edit is a…, Bake one track onto a channelbag: a location, rotation and scale key on every…, An empty every root object hangs from, for animating the model as one. Put at…, to_blender_quaternion(), to_blender_scale(), to_blender_vector() (+1 more)

### Community 46 - "Format Support Decisions"
Cohesion: 0.28
Nodes (9): Clip baking and NLA arrangement per exporter, Blender 5.2 operator inventory, Why Collada is absent, Inline theme bootstrap before first paint, What each format carries of an animation, Collada (.dae) deliberately unsupported, Create-AR 3D Model Converter, Headless Blender subprocess conversion (+1 more)

### Community 47 - "Texture Relink Tests"
Cohesion: 0.29
Nodes (8): _glb_images(), Smallest valid 1x1 PNG., Read the image list out of a GLB's JSON chunk., Marketplace archives routinely ship an .mtl full of the author's own absolute…, Matching is by exact filename so a wrong texture is never substituted., test_relinking_never_binds_a_differently_named_image(), test_textures_are_relinked_when_the_mtl_has_absolute_paths(), _tiny_png()

### Community 48 - "Fake Provider Doubles"
Cohesion: 0.25
Nodes (5): _FakeOpenAI, _PickyOpenAI, Records the call and answers with one name, like a chat deployment., A model that refuses max_tokens, then temperature, then answers. Exactly what…, _response()

### Community 49 - "NLA Clip Arrangement"
Cohesion: 0.29
Nodes (7): add_strip(), apply_clips(), new_action(), park_existing_animation(), Move every active action onto the NLA, and say where the animation the file…, Put ``action`` on a fresh NLA track of its own, which is the arrangement the…, Key every clip onto the parts it animates, one action per clip. Every part a…

### Community 50 - "Namer Settings Page"
Cohesion: 0.33
Nodes (6): NamerSettings, Provider, saveSettings(), PROVIDERS, SettingsView(), save()

### Community 51 - "Decimate to Triangle Target"
Cohesion: 0.33
Nodes (6): apply_tri_budget(), mesh_counts(), ``(name, vertices, triangles)`` per mesh object. ``evaluated`` must match what…, Evaluated triangle count per mesh object, so modifiers already set count., Decimate towards a total triangle count rather than a blind percentage. Returns…, triangle_counts()

### Community 52 - "Merge & Removal Tests"
Cohesion: 0.33
Nodes (6): make_glb(), A join keeps one object's action, so it would silently eat the clips., A GLB of one triangle drawn once per name -- the smallest many-part model.…, test_merging_collapses_every_mesh_into_one(), test_merging_is_refused_when_the_model_carries_animation(), test_removing_every_part_fails_rather_than_writing_an_empty_model()

### Community 53 - "Sample Model Generator"
Cohesion: 0.33
Nodes (3): embed_gltf_buffer(), Regenerate every sample model in this directory. .venv/Scripts/python.exe…, Inline the .bin into the .gltf so the sample is a single uploadable file.…

### Community 55 - "Part Graph Utilities"
Cohesion: 0.50
Nodes (4): hasGeometry(), NameSource, NO_SIZES, partNodes()

### Community 56 - "Naming Provider Configuration"
Cohesion: 0.40
Nodes (5): Single container behind a reverse proxy, API keys sealed with Fernet in the settings file, Adaptive retry on renamed request parameters, Four vision providers, Server-side naming settings

### Community 57 - "Material Backfill"
Cohesion: 0.50
Nodes (4): assign_material(), backfill_materials(), Put ``mat`` in every slot of ``ob``, replacing what it had., Give every unstyled mesh a plain material, and report how many. Only needed for…

### Community 58 - "Pose Sampling & Easing"
Cohesion: 0.50
Nodes (4): The fraction travelled, given the fraction of the way through in time. Mirrors…, The pose a track is in ``t`` seconds in: held before the first key and after…, sample_pose(), _shape()

### Community 59 - "Naming Endpoint Guard"
Cohesion: 0.50
Nodes (4): _configured(), name_parts(), Name one chunk of rendered parts. See naming.py for why it is a chunk., The settings, or the sentence that says what is still missing.

### Community 60 - "Settings Test Fixtures"
Cohesion: 0.50
Nodes (4): clean_settings(), _forget_quirks(), fixture, Every test starts with no saved settings and puts back what it found.

## Knowledge Gaps
- **134 isolated node(s):** `Format`, `model-converter-backend`, `name`, `private`, `version` (+129 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 464 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `test_sampling_follows_the_ease_of_the_key_being_left()` connect `API End-to-End Tests` to `Pose Sampling & Easing`?**
  _High betweenness centrality (0.084) - this node is a cross-community bridge._
- **Why does `sample_pose()` connect `Pose Sampling & Easing` to `Blender Import/Export Ops`, `API End-to-End Tests`, `Part Edits & Keyframe Baking`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `Options` connect `Clip & Options Schemas` to `Parts & Animation Document`, `FastAPI App Surface`, `API End-to-End Tests`, `Format Canonicalization`, `Format Capability Table`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `Settings` (e.g. with `Session` and `start()`) actually correct?**
  _`Settings` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Format`, `model-converter-backend`, `name` to the rest of the system?**
  _134 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Parts & Animation Document` be split into smaller, more focused modules?**
  _Cohesion score 0.05230678812812224 - nodes in this community are weakly interconnected._
- **Should `Reasoning Naming Agent` be split into smaller, more focused modules?**
  _Cohesion score 0.05765765765765766 - nodes in this community are weakly interconnected._