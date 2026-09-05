"""Regenerate every sample model in this directory.

    .venv/Scripts/python.exe samples/_generate.py

CAD samples (STEP/IGES) are built with gmsh's OpenCASCADE kernel; everything
else is exported from a single Blender scene so all the samples show the same
object. Neither gmsh nor Blender is a runtime dependency of the service -- this
script exists only to rebuild the fixtures.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))


# --- CAD: a mounting bracket, 60 x 40 x 8 mm with five holes ----------------

def build_cad() -> None:
    import gmsh

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("bracket")
        occ = gmsh.model.occ

        plate = occ.addBox(0, 0, 0, 60, 40, 8)
        holes = [occ.addCylinder(x, y, -1, 0, 0, 10, 3.0)
                 for x, y in [(8, 8), (52, 8), (8, 32), (52, 32)]]
        holes.append(occ.addCylinder(30, 20, -1, 0, 0, 10, 9.0))

        occ.cut([(3, plate)], [(3, h) for h in holes])
        occ.synchronize()

        for name in ("bracket.step", "bracket.iges"):
            gmsh.write(str(HERE / name))
            print(f"  {name}")
    finally:
        gmsh.finalize()

    # .stp / .igs are the same formats under their alternate extensions, and
    # exercise the alias table.
    shutil.copyfile(HERE / "bracket.step", HERE / "bracket_alias.stp")
    shutil.copyfile(HERE / "bracket.iges", HERE / "bracket_alias.igs")
    print("  bracket_alias.stp\n  bracket_alias.igs")


# --- Mesh/scene samples: one Blender scene exported every which way ---------

BLENDER_SCRIPT = r'''
import bpy, math, os, sys
out = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)

# A recognisable object with a material and an animation, so the samples
# exercise more than bare geometry.
bpy.ops.mesh.primitive_monkey_add(size=2, location=(0, 0, 1))
suz = bpy.context.active_object
suz.name = "Suzanne"
bpy.ops.object.shade_smooth()

bpy.ops.mesh.primitive_cylinder_add(radius=1.6, depth=0.3, location=(0, 0, -0.35))
base = bpy.context.active_object
base.name = "Base"

mat = bpy.data.materials.new("Brass")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.72, 0.51, 0.16, 1.0)
bsdf.inputs["Metallic"].default_value = 0.9
bsdf.inputs["Roughness"].default_value = 0.25
suz.data.materials.append(mat)

mat2 = bpy.data.materials.new("Slate")
mat2.use_nodes = True
mat2.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.09, 0.10, 0.13, 1.0)
base.data.materials.append(mat2)

# A short spin, so animation-carrying formats have something to carry.
suz.rotation_mode = "XYZ"
for frame, z in ((1, 0.0), (60, math.radians(360))):
    suz.rotation_euler[2] = z
    suz.keyframe_insert("rotation_euler", frame=frame)
bpy.context.scene.frame_end = 60

targets = [
    ("suzanne.glb",  lambda p: bpy.ops.export_scene.gltf(filepath=p, export_format="GLB")),
    ("suzanne.gltf", lambda p: bpy.ops.export_scene.gltf(filepath=p, export_format="GLTF_SEPARATE")),
    ("suzanne.fbx",  lambda p: bpy.ops.export_scene.fbx(filepath=p, path_mode="COPY", embed_textures=True)),
    ("suzanne.obj",  lambda p: bpy.ops.wm.obj_export(filepath=p, path_mode="COPY")),
    ("suzanne.stl",  lambda p: bpy.ops.wm.stl_export(filepath=p)),
    ("suzanne.ply",  lambda p: bpy.ops.wm.ply_export(filepath=p)),
    ("suzanne.usdz", lambda p: bpy.ops.wm.usd_export(filepath=p)),
    ("suzanne.usdc", lambda p: bpy.ops.wm.usd_export(filepath=p)),
    ("suzanne.usda", lambda p: bpy.ops.wm.usd_export(filepath=p)),
    ("suzanne.abc",  lambda p: bpy.ops.wm.alembic_export(filepath=p)),
]
for name, fn in targets:
    path = os.path.join(out, name)
    try:
        fn(path)
        print("@@OK " + name + " " + str(os.path.getsize(path)))
    except Exception as exc:
        print("@@FAIL " + name + " " + str(exc))

# Saved last: open_mainfile would replace the scene we just built.
blend = os.path.join(out, "suzanne.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend)
print("@@OK suzanne.blend " + str(os.path.getsize(blend)))
'''


def build_meshes() -> None:
    from app import config  # noqa: E402  (path set at import time)

    blender = config.find_blender()
    if not blender:
        raise SystemExit("Blender not found; set BLENDER_PATH.")

    script = HERE / "_blender_samples.py"
    script.write_text(BLENDER_SCRIPT, encoding="utf-8")
    try:
        proc = subprocess.run(
            [blender, "-b", "--factory-startup", "--python", str(script), "--", str(HERE)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
        )
    finally:
        script.unlink(missing_ok=True)

    for line in proc.stdout.splitlines():
        if line.startswith("@@"):
            print("  " + line[2:])
    if proc.returncode != 0:
        raise SystemExit(f"Blender exited {proc.returncode}\n{proc.stdout[-2000:]}")


def embed_gltf_buffer() -> None:
    """Inline the .bin into the .gltf so the sample is a single uploadable file.

    Blender only writes glTF with a sidecar buffer, but a sample is uploaded on
    its own -- without the .bin it would import an empty scene.
    """
    import base64
    import json

    gltf_path = HERE / "suzanne.gltf"
    doc = json.loads(gltf_path.read_text(encoding="utf-8"))
    for buffer in doc.get("buffers", []):
        uri = buffer.get("uri")
        if not uri or uri.startswith("data:"):
            continue
        raw = (HERE / uri).read_bytes()
        buffer["uri"] = "data:application/octet-stream;base64," + base64.b64encode(raw).decode()
        (HERE / uri).unlink(missing_ok=True)
    gltf_path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"  suzanne.gltf {gltf_path.stat().st_size} (buffer embedded)")


if __name__ == "__main__":
    print("CAD (gmsh / OpenCASCADE):")
    build_cad()
    print("Mesh + scene (Blender):")
    build_meshes()
    print("Post-processing:")
    embed_gltf_buffer()
    print("\nDone. Samples in", HERE)
