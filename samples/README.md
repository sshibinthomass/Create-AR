# Sample models

One file per supported input format, for testing the converter. Drag any of
them onto the upload area.

There are two source objects, so the samples exercise different things:

- **`suzanne.*`** — Blender's Suzanne on a cylindrical base. Two meshes, two
  materials (a metallic brass and a matte slate), and a 60-frame rotation, so
  formats that carry materials and animation have something to carry.
  1,092 triangles, roughly 3.2 × 3.2 × 2.5 m.
- **`bracket.*`** — a mounting plate, 60 × 40 × 8 mm, with four corner holes and
  a central bore. Real parametric CAD B-rep, tessellated on import.
  1,292 triangles at the default tolerance.

| File | Format | Notes |
|---|---|---|
| `suzanne.glb` | glTF Binary | Materials + animation. |
| `suzanne.gltf` | glTF | Buffer embedded as a data URI so it works as a single upload. |
| `suzanne.fbx` | FBX | Materials + animation. |
| `suzanne.obj` | Wavefront OBJ | See the `.mtl` note below. |
| `suzanne.stl` | STL | Geometry only — no materials, flat shading. |
| `suzanne.ply` | PLY | Geometry only. |
| `suzanne.usdz` | USDZ | Also a valid AR Quick Look file. |
| `suzanne.usdc` | USD Binary | |
| `suzanne.usda` | USD ASCII | Human-readable; open it to see the scene graph. |
| `suzanne.abc` | Alembic | Baked geometry cache. |
| `suzanne.blend` | Blender | Opened directly. |
| `bracket.step` | STEP AP214 | Tessellated by OpenCASCADE. |
| `bracket.iges` | IGES | Tessellated by OpenCASCADE. |
| `bracket_alias.stp` | STEP | Same file — exercises the `.stp` → `.step` alias. |
| `bracket_alias.igs` | IGES | Same file — exercises the `.igs` → `.iges` alias. |

## Two things that look like bugs but are not

**`suzanne.obj` uploads without its materials.** OBJ keeps materials in a
sidecar `suzanne.mtl`, and only the `.obj` itself is uploaded, so the result is
untextured grey. The geometry is unaffected. This is inherent to single-file OBJ
upload, not a conversion fault — `suzanne.mtl` is kept here for reference.

**The bracket looks tiny in the stats.** STEP declares millimetres and
OpenCASCADE emits metres, so 60 × 40 × 8 mm is reported as
`0.060 × 0.008 × 0.040 m`. The Y and Z figures are swapped because the glTF
importer converts Y-up to Blender's Z-up. Both are correct; see
[../docs/FORMATS.md](../docs/FORMATS.md).

## Regenerating

The samples are checked in, so this is only needed if you want to change them.
It needs Blender plus `gmsh` (`pip install gmsh`), neither of which is a runtime
dependency of the service:

```bash
.venv/Scripts/python.exe samples/_generate.py
```
