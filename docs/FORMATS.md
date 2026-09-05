# Format support — what the engines actually provide

Everything here was verified by introspecting a real Blender 5.2.0 LTS install
rather than read from documentation, because Blender's I/O operator set has
changed substantially across recent releases.

## Blender 5.2 operator inventory

Dumping the operator namespaces gives the authoritative list:

```python
import bpy
print(sorted(dir(bpy.ops.import_scene)))   # ['bvh', 'fbx', 'gltf']
print(sorted(dir(bpy.ops.export_scene)))   # ['fbx', 'gltf']
print([o for o in dir(bpy.ops.wm) if 'import' in o or 'export' in o])
# alembic_import/export, obj_import/export, ply_import/export,
# stl_import/export, usd_import/export, grease_pencil_*
```

| Format | Import | Export | Operator |
|---|:--:|:--:|---|
| glTF / GLB | ✅ | ✅ | `import_scene.gltf` / `export_scene.gltf` |
| FBX | ✅ | ✅ | `import_scene.fbx` / `export_scene.fbx` |
| OBJ | ✅ | ✅ | `wm.obj_import` / `wm.obj_export` |
| STL | ✅ | ✅ | `wm.stl_import` / `wm.stl_export` |
| PLY | ✅ | ✅ | `wm.ply_import` / `wm.ply_export` |
| USD (incl. USDZ) | ✅ | ✅ | `wm.usd_import` / `wm.usd_export` |
| Alembic | ✅ | ✅ | `wm.alembic_import` / `wm.alembic_export` |
| **Collada (`.dae`)** | ❌ | ❌ | **removed in Blender 5.x** |
| **X3D / VRML** | ❌ | ❌ | no longer bundled |
| **3DS** | ❌ | ❌ | no longer bundled |
| STEP / IGES | ❌ | ❌ | Blender has no CAD kernel |

`--factory-startup` is used for every run to guarantee a reproducible
environment. The glTF and FBX add-ons are core-enabled and remain available
under it — verified, not assumed.

## Why Collada is absent

Blender's Collada support was dropped during the 5.x cycle; neither
`wm.collada_import` nor `wm.collada_export` exists in 5.2. Advertising `.dae`
would mean failing at conversion time, so it is absent from the registry
instead.

## CAD input: OpenCASCADE, not Blender

STEP and IGES describe boundary representations (trimmed NURBS surfaces), not
meshes. Blender cannot read them at all. The pipeline uses
[`cascadio`](https://pypi.org/project/cascadio/), a wheel-packaged OpenCASCADE
binding, to tessellate B-rep into a GLB, which Blender then imports normally.

```python
cascadio.load(step_bytes, file_type="step", tol_linear=0.01, tol_angular=0.5)
```

`tol_linear` is the linear deflection tolerance, exposed in the UI as "CAD
tessellation". Lower values track the true surface more closely at the cost of
triangle count and conversion time.

Two consequences worth knowing:

- **Units.** STEP files usually declare millimetres. OpenCASCADE applies the
  declared unit and emits glTF in metres, so a 2 mm × 1 mm × 3 mm part arrives as
  `0.002 × 0.001 × 0.003`. This is correct, not a scaling bug.
- **No merged vertices.** Each tessellated face carries its own vertices, so a
  six-faced box yields 24 vertices rather than 8, and is not watertight by
  trimesh's definition. Enable *Simplify* or merge in a downstream tool if that
  matters.

## Axis conventions

Blender is Z-up. Most delivery targets are Y-up, and getting this wrong is the
single most common cause of models lying on their side in AR:

| Target | Handling |
|---|---|
| glTF / GLB | `export_yup=True`; the exporter converts. |
| USD / USDZ | `convert_orientation=True` with up `Y`, forward `-Z`. **Required by ARKit and Quick Look.** Exposed as the *Y-up* toggle. |
| FBX | `axis_up='Y'`, `axis_forward='-Z'`. |
| OBJ / STL / PLY | `up_axis='Y'`, `forward_axis='NEGATIVE_Z'`. |

Because the glTF importer converts Y-up to Blender's Z-up on the way in, the
bounding box reported for a model that arrived via glTF or CAD is expressed in
Blender's axes — the Y and Z extents appear swapped relative to the source file.

## USDZ specifics

USDZ is an uncompressed zip with alignment requirements. Blender's exporter
selects it from the `.usdz` file extension, and the output is validated in the
test suite:

- every entry uses `ZIP_STORED` (no deflate), and
- the archive contains a `.usdc` or `.usda` root layer.

## Multi-file outputs

`.obj` emits `.obj` + `.mtl` + copied textures, and `.gltf` (separate) emits
`.gltf` + `.bin` + textures. Both are zipped before download; single-file
targets are served as-is with their proper MIME type.

## Archives as input

A `.zip` upload is unpacked and the model inside is converted. This matters
beyond convenience: OBJ keeps its materials in a sidecar `.mtl` and glTF keeps
geometry in a `.bin`, so uploading either of those files alone silently loses
data. Extracting preserves the directory structure, which is what makes the
relative references inside those files resolve.

### Containers

Detection is by magic bytes, never by extension, because archives are routinely
misnamed:

| Container | Detected by | Library |
|---|---|---|
| zip | `PK` | `zipfile` |
| 7z | `7z¼¯'` | `py7zr` |
| gzip / bzip2 / xz tarball | ``, `BZh`, `ý7zXZ` | `tarfile` |
| plain tar | `ustar` at offset 257 | `tarfile` |
| RAR | `Rar!` | *reported as unsupported* |

RAR is deliberately identified so the error names the problem; supporting it
would mean shipping a non-redistributable `unrar` binary.

7z has no per-member streaming API, so it is handled separately: every name is
validated and the declared sizes are summed *before* a byte is written, then the
archive is expanded in one call.

### Layout

No layout is assumed. Models are found by walking the whole tree, so wrapper
folders, spaces, and arbitrary nesting are all irrelevant. Archives inside
archives are opened recursively to `MAX_DEPTH` (4) while nothing has been found
yet, which handles mixed chains such as `.zip` → `.tar.gz` → `.zip`. A `source/`
folder is tried first, being the conventional home for an original.

Recursion stops as soon as a model turns up: if the top level already offers one
there is no reason to spend time unpacking a bundle's extras.

USDZ is itself a zip, so containers are only recursed into when they are *not* a
recognised model format — otherwise a `.usdz` would be torn open instead of
converted.

Selection between multiple candidates is by format preference (GLB, glTF, FBX,
OBJ, blend, USD, Alembic, STL, PLY, STEP, IGES), then shallowest path, then
largest file. `__MACOSX/` entries and `._` resource forks are ignored. Every
candidate is returned, not just the winner, so the caller can override the pick
via `options.archive_entry` — the UI turns that into a one-click list.

### Extraction safety

`safe_extract` refuses, rather than sanitises:

- **Zip-slip** — absolute paths, `..` components, drive letters, and any entry
  whose resolved target escapes the destination. Backslash separators are
  normalised first so `..\..\x` cannot slip past a forward-slash-only check.
- **Symlinks** — entries whose Unix mode marks them `S_IFLNK` are skipped, so a
  link cannot be materialised pointing outside the sandbox.
- **Entry floods** — more than `MAX_ENTRIES` (4,000).
- **Decompression bombs** — the running total is checked while writing, and for
  7z the declared total is checked up front, so a lying central directory does
  not get a free pass. The budget is shared across nesting levels, so recursion
  cannot multiply it.
- **Encrypted archives** — a password-protected 7z is reported plainly rather
  than failing deep inside the library.

Absolute paths are *refused*, not stripped. Most unzip tools quietly rewrite
`/etc/passwd` to `etc/passwd`; here it aborts, because an absolute path in a
distributed model bundle is a red flag worth surfacing to whoever uploaded it.

### Texture relinking

After import, any image whose recorded filepath does not exist is rebound to a
file of the same *filename* found anywhere under the extraction root. This
repairs the extremely common case of an `.mtl` carrying the author's own
absolute paths:

```
map_Kd C:/Users/someone/DefaultMaterial_baseColor.jpeg
```

while the archive actually ships `textures/DefaultMaterial_baseColor.jpeg`.

Matching is deliberately by exact filename and nothing else — no fuzzy matching,
no extension substitution — so the wrong texture is never bound to a material.
A reference to `DefaultMaterial_normal.jpeg` in an archive shipping
`DefaultMaterial_normal.png` therefore stays unresolved, which is the correct
outcome: the source file is wrong and guessing could be worse than a miss. The
count of relinked images is reported in the job log.
