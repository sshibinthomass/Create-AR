"""Runs *inside* Blender: ``blender -b --factory-startup --python blender_job.py -- cfg.json``

Standalone by necessity -- Blender ships its own interpreter and cannot import
the backend package. Communicates back over stdout using ``@@`` line markers.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Vector

MARKER = "@@"


def emit(kind, **payload):
    print(MARKER + kind + " " + json.dumps(payload), flush=True)


# --- format tables -----------------------------------------------------------
# Parameter names verified against Blender 5.2 operator RNA; see docs/FORMATS.md.

def _import_gltf(path, o):
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=o.get("merge_vertices", False))


def _import_fbx(path, o):
    bpy.ops.import_scene.fbx(filepath=path, global_scale=1.0, use_anim=True)


def _import_obj(path, o):
    bpy.ops.wm.obj_import(filepath=path, forward_axis="NEGATIVE_Z", up_axis="Y")


def _import_stl(path, o):
    bpy.ops.wm.stl_import(filepath=path, global_scale=1.0)


def _import_ply(path, o):
    bpy.ops.wm.ply_import(filepath=path, global_scale=1.0)


def _import_usd(path, o):
    bpy.ops.wm.usd_import(filepath=path, scale=1.0, import_materials=True)


def _import_abc(path, o):
    bpy.ops.wm.alembic_import(filepath=path, scale=1.0)


def _import_blend(path, o):
    bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)


IMPORTERS = {
    ".glb": _import_gltf, ".gltf": _import_gltf,
    ".fbx": _import_fbx,
    ".obj": _import_obj,
    ".stl": _import_stl,
    ".ply": _import_ply,
    ".usd": _import_usd, ".usda": _import_usd, ".usdc": _import_usd, ".usdz": _import_usd,
    ".abc": _import_abc,
    ".blend": _import_blend,
}


def _export_gltf(path, o, binary=True):
    kw = {}
    if binary and o.get("draco"):
        kw["export_draco_mesh_compression_enable"] = True
        kw["export_draco_mesh_compression_level"] = int(o.get("draco_level", 6))
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB" if binary else "GLTF_SEPARATE",
        export_apply=bool(o.get("apply_modifiers", True)),
        export_yup=True,
        export_materials="EXPORT",
        export_animations=bool(o.get("animations", True)),
        **kw
    )


def _export_usd(path, o):
    kw = {}
    # iOS QuickLook / ARKit expect Y-up; Blender authors Z-up.
    if o.get("y_up", True):
        kw["convert_orientation"] = True
        kw["export_global_up_selection"] = "Y"
        kw["export_global_forward_selection"] = "NEGATIVE_Z"
    bpy.ops.wm.usd_export(
        filepath=path,
        export_materials=True,
        export_animation=bool(o.get("animations", True)),
        relative_paths=True,
        root_prim_path="/root",
        **kw
    )


def _export_fbx(path, o):
    bpy.ops.export_scene.fbx(
        filepath=path, path_mode="COPY", embed_textures=True,
        use_mesh_modifiers=bool(o.get("apply_modifiers", True)),
        bake_anim=bool(o.get("animations", True)),
        axis_forward="-Z", axis_up="Y", apply_unit_scale=True)


def _export_obj(path, o):
    bpy.ops.wm.obj_export(
        filepath=path, path_mode="COPY", export_materials=True,
        apply_modifiers=bool(o.get("apply_modifiers", True)),
        export_triangulated_mesh=bool(o.get("triangulate", False)),
        forward_axis="NEGATIVE_Z", up_axis="Y")


def _export_stl(path, o):
    bpy.ops.wm.stl_export(
        filepath=path, apply_modifiers=bool(o.get("apply_modifiers", True)),
        ascii_format=bool(o.get("ascii", False)),
        forward_axis="NEGATIVE_Z", up_axis="Y")


def _export_ply(path, o):
    bpy.ops.wm.ply_export(
        filepath=path, apply_modifiers=bool(o.get("apply_modifiers", True)),
        ascii_format=bool(o.get("ascii", False)),
        forward_axis="NEGATIVE_Z", up_axis="Y")


def _export_abc(path, o):
    bpy.ops.wm.alembic_export(filepath=path)


EXPORTERS = {
    ".glb": lambda p, o: _export_gltf(p, o, binary=True),
    ".gltf": lambda p, o: _export_gltf(p, o, binary=False),
    ".fbx": _export_fbx,
    ".obj": _export_obj,
    ".stl": _export_stl,
    ".ply": _export_ply,
    ".abc": _export_abc,
    ".usdz": _export_usd, ".usdc": _export_usd, ".usda": _export_usd, ".usd": _export_usd,
}


# --- scene helpers -----------------------------------------------------------

def mesh_objects():
    return [ob for ob in bpy.data.objects if ob.type in {"MESH", "CURVE", "SURFACE", "FONT", "META"}]


def world_bounds():
    """Axis-aligned bounds of all renderable geometry, in world space."""
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for ob in mesh_objects():
        for corner in ob.bound_box:
            v = ob.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], v[i])
                hi[i] = max(hi[i], v[i])
    if not math.isfinite(lo[0]):
        return None, None
    return lo, hi


def scene_stats():
    verts = 0
    tris = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        try:
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
        except Exception:
            continue
        if me is None:
            continue
        verts += len(me.vertices)
        tris += sum(max(len(p.vertices) - 2, 0) for p in me.polygons)
        ev.to_mesh_clear()
    lo, hi = world_bounds()
    return {
        "objects": len(bpy.data.objects),
        "meshes": len([o for o in bpy.data.objects if o.type == "MESH"]),
        "materials": len(bpy.data.materials),
        "vertices": verts,
        "triangles": tris,
        "dimensions": [round(hi[i] - lo[i], 6) for i in range(3)] if lo else None,
    }


def relink_missing_textures(search_root):
    """Repoint textures whose recorded path does not exist onto files we do have.

    Distributed archives very often carry absolute paths from the original
    author's machine (``map_Kd C:/foo_baseColor.jpeg``) while shipping the actual
    images in a sibling ``textures/`` folder. Without this the model converts
    untextured, which looks like a conversion bug but is a defect in the source.
    Matching is by filename, so it only ever rebinds an image to a file of the
    same name that really is in the upload.
    """
    if not search_root or not os.path.isdir(search_root):
        return 0

    index = {}
    for dirpath, _, filenames in os.walk(search_root):
        for name in filenames:
            # First match wins; shallower directories are walked first.
            index.setdefault(name.lower(), os.path.join(dirpath, name))

    fixed = 0
    for img in bpy.data.images:
        if img.source != "FILE" or img.packed_file:
            continue
        raw = img.filepath or ""
        if not raw:
            continue
        current = bpy.path.abspath(raw)
        if current and os.path.exists(current):
            continue
        base = os.path.basename(raw.replace("\\", "/")).lower()
        hit = index.get(base)
        if not hit:
            continue
        img.filepath = hit
        try:
            img.reload()
            fixed += 1
        except Exception:
            pass
    return fixed


def transform_roots(fn):
    """Apply ``fn`` to every root object (children follow via parenting)."""
    for ob in bpy.data.objects:
        if ob.parent is None:
            fn(ob)


def apply_scale(factor):
    if abs(factor - 1.0) < 1e-9:
        return

    def do(ob):
        ob.scale = [s * factor for s in ob.scale]
        ob.location = [v * factor for v in ob.location]

    transform_roots(do)
    bpy.context.view_layer.update()


def apply_center(mode):
    """``origin`` centres the bounding box; ``floor`` also drops it onto Z=0."""
    if mode not in {"origin", "floor"}:
        return
    lo, hi = world_bounds()
    if lo is None:
        return
    dx = -(lo[0] + hi[0]) / 2.0
    dy = -(lo[1] + hi[1]) / 2.0
    dz = -lo[2] if mode == "floor" else -(lo[2] + hi[2]) / 2.0

    def do(ob):
        ob.location[0] += dx
        ob.location[1] += dy
        ob.location[2] += dz

    transform_roots(do)
    bpy.context.view_layer.update()


def apply_renames(mapping):
    """Rename objects before export, so the names travel into the output file.

    glTF nodes, USD prims, FBX objects and OBJ groups are all written from the
    object name; STL and PLY carry no per-part names at all. The mesh datablock
    is renamed alongside when nothing else shares it, because some exporters
    prefer it over the object name.
    """
    if not mapping:
        return 0
    done = 0
    for old_name, new_name in mapping.items():
        ob = bpy.data.objects.get(old_name)
        if ob is None or not new_name or new_name == old_name:
            continue
        ob.name = new_name
        if ob.data is not None and ob.data.users == 1:
            ob.data.name = new_name
        done += 1
    return done


def apply_triangulate():
    for ob in bpy.data.objects:
        if ob.type == "MESH":
            m = ob.modifiers.new("cv_tri", "TRIANGULATE")
            m.quad_method = "SHORTEST_DIAGONAL"


def apply_decimate(ratio):
    if not (0.0 < ratio < 1.0):
        return
    for ob in bpy.data.objects:
        if ob.type == "MESH" and len(ob.data.polygons) > 8:
            m = ob.modifiers.new("cv_dec", "DECIMATE")
            m.ratio = ratio


# --- main --------------------------------------------------------------------

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    with open(argv[0], encoding="utf-8") as fh:
        cfg = json.load(fh)

    src = cfg["input"]
    src_ext = cfg["input_ext"].lower()
    dst = cfg["output"]
    dst_ext = cfg["output_ext"].lower()
    preview = cfg.get("preview")
    o = cfg.get("options", {})

    if src_ext not in IMPORTERS:
        emit("error", message="no Blender importer for '" + src_ext + "'")
        sys.exit(2)
    if dst_ext not in EXPORTERS:
        emit("error", message="no Blender exporter for '" + dst_ext + "'")
        sys.exit(2)

    emit("progress", pct=15, step="Importing " + src_ext)
    if src_ext != ".blend":
        bpy.ops.wm.read_factory_settings(use_empty=True)
    IMPORTERS[src_ext](src, o)

    if not bpy.data.objects:
        emit("error", message="import produced an empty scene")
        sys.exit(3)

    relinked = relink_missing_textures(cfg.get("texture_root"))
    if relinked:
        emit("info", message="Relinked " + str(relinked) + " texture(s) by filename")

    emit("stats", source=scene_stats())

    renamed = apply_renames(o.get("renames") or {})
    if renamed:
        emit("info", message="Renamed " + str(renamed) + " part(s)")

    emit("progress", pct=45, step="Transforming")
    apply_scale(float(o.get("scale", 1.0)))
    apply_center(o.get("center", "none"))
    if o.get("triangulate"):
        apply_triangulate()
    apply_decimate(float(o.get("decimate", 1.0)))

    emit("progress", pct=60, step="Exporting " + dst_ext)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    EXPORTERS[dst_ext](dst, o)
    if not os.path.exists(dst):
        emit("error", message="exporter wrote no file for '" + dst_ext + "'")
        sys.exit(4)

    if preview and dst_ext != ".glb":
        emit("progress", pct=85, step="Building preview")
        try:
            _export_gltf(preview, {"apply_modifiers": True, "animations": True}, binary=True)
        except Exception as exc:  # preview is best-effort, never fatal
            emit("warn", message="preview export failed: " + str(exc))

    emit("stats", result=scene_stats())
    emit("progress", pct=100, step="Done")
    emit("done", output=dst)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        import traceback
        emit("error", message=type(exc).__name__ + ": " + str(exc),
             traceback=traceback.format_exc())
        sys.exit(1)
