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
