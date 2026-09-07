"""Runs *inside* Blender: ``blender -b --factory-startup --python blender_job.py -- cfg.json``

Standalone by necessity -- Blender ships its own interpreter and cannot import
the backend package. Communicates back over stdout using ``@@`` line markers.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

MARKER = "@@"


def emit(kind, **payload):
    print(MARKER + kind + " " + json.dumps(payload), flush=True)


def warn_missing(names, what):
    """Say which named parts no object answered to, and what did not happen.

    Reported rather than passed over: a model exported without the change the
    user asked for is the one outcome they cannot tell apart from a bug. Only
    the first few are listed -- a rename against the wrong file misses every
    part, and a warning listing five hundred of them says nothing extra.
    """
    if not names:
        return
    more = " (and " + str(len(names) - 5) + " more)" if len(names) > 5 else ""
    emit("warn", message="No part named "
         + ", ".join("'" + n + "'" for n in names[:5]) + more + " -- " + what)


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
    # The images on disk are already at the size and quality asked for, so the
    # exporter is told the format only -- naming WEBP is what makes it declare
    # EXT_texture_webp instead of quietly re-encoding back to PNG.
    if o.get("texture_format") == "webp":
        kw["export_image_format"] = "WEBP"
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
    kw = {}
    # The FBX exporter writes one take per NLA strip, and a strip belongs to
    # one object -- so a clip that moves ten parts would come out as ten takes
    # of the same name, each moving one part. With clips authored here the
    # whole timeline is baked as a single take instead, the clips one after
    # another, which is what USD and Alembic get as well.
    if o.get("clips"):
        kw["bake_anim_use_nla_strips"] = False
        kw["bake_anim_use_all_actions"] = False
    bpy.ops.export_scene.fbx(
        filepath=path, path_mode="COPY", embed_textures=True,
        use_mesh_modifiers=bool(o.get("apply_modifiers", True)),
        bake_anim=bool(o.get("animations", True)),
        axis_forward="-Z", axis_up="Y", apply_unit_scale=True, **kw)


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


def mesh_counts(evaluated=True):
    """``(name, vertices, triangles)`` per mesh object.

    ``evaluated`` must match what the exporter is about to do. Simplify, the
    triangle budget, merge-by-distance and triangulate are all *modifiers*, so
    with "apply modifiers" off none of them reach the file -- and counting the
    evaluated mesh would report a reduction the download does not have.

    A list rather than a generator: each evaluated mesh has to be released after
    it is counted, and a consumer that stopped early would leave them behind.
    """
    out = []
    dg = bpy.context.evaluated_depsgraph_get() if evaluated else None
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        if evaluated:
            try:
                ev = ob.evaluated_get(dg)
                me = ev.to_mesh()
            except Exception:
                continue
            if me is None:
                continue
        else:
            ev, me = None, ob.data
        out.append((ob.name, len(me.vertices),
                    sum(max(len(p.vertices) - 2, 0) for p in me.polygons)))
        if ev is not None:
            ev.to_mesh_clear()
    return out


def scene_stats(evaluated=True):
    """Count what the scene holds."""
    counts = mesh_counts(evaluated)
    verts = sum(v for _, v, _ in counts)
    tris = sum(t for _, _, t in counts)
    lo, hi = world_bounds()
    return {
        "objects": len(bpy.data.objects),
        "meshes": len([o for o in bpy.data.objects if o.type == "MESH"]),
        "materials": len(bpy.data.materials),
        "vertices": verts,
        "triangles": tris,
        "dimensions": [round(hi[i] - lo[i], 6) for i in range(3)] if lo else None,
        "images": len(bpy.data.images),
        # Texture area, which is what a resolution cap actually trades away.
        "texturePixels": sum(im.size[0] * im.size[1] for im in bpy.data.images),
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


def apply_removals(names):
    """Delete whole parts from the scene before anything else touches them.

    A part is removed with everything hanging off it: a glTF part is routinely a
    node with its meshes as children, and leaving those behind would export the
    geometry the user just deleted under a different name.

    Returns ``(removed, missing)`` -- a name with no object behind it is
    reported rather than passed over, for the same reason an edit's is.
    """
    if not names:
        return 0, []

    doomed = []
    missing = []
    for name in names:
        ob = bpy.data.objects.get(name)
        if ob is None:
            missing.append(name)
            continue
        doomed.append(ob)
        doomed.extend(ob.children_recursive)

    # One object can be reached twice -- as a name of its own and as a child of
    # another doomed part -- and removing it twice is a crash, not a no-op.
    seen = set()
    removed = 0
    for ob in doomed:
        if ob.name in seen:
            continue
        seen.add(ob.name)
        bpy.data.objects.remove(ob, do_unlink=True)
        removed += 1

    bpy.context.view_layer.update()
    return removed, missing


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


# Edits are authored against the GLB preview, which was written with
# ``export_yup``. That option maps every node's *local* transform onto glTF's
# axes componentwise, at any depth in the hierarchy -- verified against Blender
# 5.2: an object at (0.5, -0.25, 0.75), scale (1.3, 0.7, 1.0), exports as a node
# at (0.5, 0.75, 0.25), scale (1.3, 1.0, 0.7), nested or not. So an edit made in
# the viewer is a local delta in glTF axes, and only has to be swizzled back.
#
# Position and the vector part of a rotation both flip: (x, y, z) -> (x, -z, y).
# Scale is unsigned, so it only swaps: (x, y, z) -> (x, z, y).

def to_blender_vector(v):
    return Vector((v[0], -v[2], v[1]))


def to_blender_scale(s):
    return Vector((s[0], s[2], s[1]))


def to_blender_quaternion(q):
    return Quaternion((q.w, q.x, -q.z, q.y))


# Principled BSDF settings per material name, mirroring MATERIALS in
# frontend/src/api.ts so the viewer's preview matches the exported file.
# (metallic, roughness, transmission, emission strength)
MATERIALS = {
    "plastic": (0.0, 0.35, 0.0, 0.0),
    "metal": (1.0, 0.25, 0.0, 0.0),
    "glass": (0.0, 0.05, 1.0, 0.0),
    "matte": (0.0, 0.90, 0.0, 0.0),
    "emissive": (0.0, 0.50, 0.0, 2.0),
}

NEUTRAL = (0.0, 0.5, 0.0, 0.0)  # for parts that had no material of their own


def hex_to_linear(value):
    """'#rrggbb' from a colour input -> the linear RGB Blender shades in.

    Browser colour pickers speak sRGB; a Principled BSDF socket is linear, and
    so is glTF's baseColorFactor. Skipping the transfer function here would
    export every colour noticeably lighter than the one that was picked.
    """
    digits = value.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(digits[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def set_alpha(mat, alpha):
    """Dial one material's opacity down, and let the exporter know it blends.

    Both blend properties are set. Blender grew a second one with EEVEE Next
    and which of the two the glTF exporter reads has moved between releases,
    so writing only one is a coin toss on the alpha mode reaching the file.
    """
    if alpha >= 1.0:
        return
    for prop, value in (("blend_method", "BLEND"),
                        ("surface_render_method", "BLENDED")):
        if hasattr(mat, prop):
            setattr(mat, prop, value)
    if mat.use_nodes and mat.node_tree is not None:
        for node in mat.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            socket = node.inputs.get("Alpha")
            # A linked alpha is driven by a texture; overriding the value would
            # be ignored anyway, and unlinking it would throw the texture away.
            if socket is not None and not socket.is_linked:
                socket.default_value = alpha
    mat.diffuse_color = (*mat.diffuse_color[:3], alpha)


def build_material(name, settings, color, alpha=1.0, metallic=None, roughness=None):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:  # a factory-startup node tree always has one
        return mat
    preset_metallic, preset_roughness, transmission, emission = settings
    if metallic is None:
        metallic = preset_metallic
    if roughness is None:
        roughness = preset_roughness
    r, g, b = hex_to_linear(color)
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Transmission Weight"].default_value = transmission
    bsdf.inputs["Emission Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Emission Strength"].default_value = emission
    bsdf.inputs["Alpha"].default_value = alpha
    set_alpha(mat, alpha)
    return mat


def set_base_color(mat, color):
    """Recolour one material without replacing it.

    The part keeps its own finish -- roughness, metalness, every map it wears --
    and only the colour underneath them changes, which is how a part is picked
    out of an assembly without pretending it is made of something else.

    A Base Color driven by a texture cannot simply be overwritten: the value
    behind a link is ignored. The texture is multiplied by the colour instead,
    which is exactly what three.js does to `map` when `material.color` is set --
    so a textured part tints in the file the way it tinted in the preview.
    """
    r, g, b = hex_to_linear(color)
    mat.diffuse_color = (r, g, b, mat.diffuse_color[3])
    if not mat.use_nodes or mat.node_tree is None:
        return
    for node in list(mat.node_tree.nodes):
        if node.type != "BSDF_PRINCIPLED":
            continue
        socket = node.inputs.get("Base Color")
        if socket is None:
            continue
        if not socket.is_linked:
            socket.default_value = (r, g, b, 1.0)
            continue
        tint = make_multiply_node(mat.node_tree, (r, g, b))
        if tint is None:  # no mix node this build knows: leave the texture be
            continue
        source, output = socket.links[0].from_socket, tint[0]
        mat.node_tree.links.new(tint[1], source)
        mat.node_tree.links.new(socket, output)


def make_multiply_node(tree, rgb):
    """A node multiplying one input colour by ``rgb``: ``(output, input)``.

    Blender replaced MixRGB with a general Mix node, and which of the two a
    build has moved across releases -- so whichever is registered is used, and
    the sockets are taken by index because the general node names several of
    them the same thing.
    """
    for kind in ("ShaderNodeMix", "ShaderNodeMixRGB"):
        try:
            node = tree.nodes.new(kind)
        except RuntimeError:
            continue
        node.blend_type = "MULTIPLY"
        if kind == "ShaderNodeMix":
            node.data_type = "RGBA"
            # Factor, then the two colour inputs; RGBA sockets sit after the
            # float and vector ones, which is why these are found by type.
            colours = [s for s in node.inputs if s.type == "RGBA"]
            node.inputs[0].default_value = 1.0
            colours[1].default_value = (*rgb, 1.0)
            out = [s for s in node.outputs if s.type == "RGBA"][0]
            return out, colours[0]
        node.inputs["Fac"].default_value = 1.0
        node.inputs["Color2"].default_value = (*rgb, 1.0)
        return node.outputs["Color"], node.inputs["Color1"]
    return None


def fade_object(ob, alpha, color=None):
    """Fade or recolour one object without replacing how it is shaded.

    A preset swaps a part's materials outright; opacity and colour on their own
    have to keep them, because the whole point of fading a housing is to look at
    what is inside it *through* its own finish, and of recolouring a part is to
    find it without restyling it. Mesh data and materials are both routinely
    shared between objects, so each is forked before it is touched -- otherwise
    fading one part fades every part instanced from the same mesh.
    """
    if ob.type != "MESH" or ob.data is None:
        return False
    if ob.data.users > 1:
        ob.data = ob.data.copy()
    if not ob.data.materials:
        # Nothing to fade a copy of -- most CAD and STL input arrives this way.
        ob.data.materials.append(build_material(
            ob.name + "_material", NEUTRAL, color or "#cccccc", alpha))
        return True
    for slot, mat in enumerate(ob.data.materials):
        if mat is None:
            continue
        own = mat.copy()
        set_alpha(own, alpha)
        if color is not None:
            set_base_color(own, color)
        ob.data.materials[slot] = own
    return True


def assign_material(ob, mat):
    """Put ``mat`` in every slot of ``ob``, replacing what it had."""
    if ob.type != "MESH" or ob.data is None:
        return False
    # Restyling one part must not restyle every other part instanced from the
    # same mesh, so a shared datablock is forked first.
    if ob.data.users > 1:
        ob.data = ob.data.copy()
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return True


def backfill_materials():
    """Give every unstyled mesh a plain material, and report how many.

    Only needed for OBJ: ``usemtl`` is a running state in the file, so a part
    written after a styled one and carrying no material of its own silently
    inherits that style. A model with no materials at all -- most CAD and STL
    input -- hits this the moment a single part is given a colour.
    """
    plain = None
    done = 0
    for ob in bpy.data.objects:
        if ob.type != "MESH" or ob.data is None:
            continue
        if any(slot.material for slot in ob.material_slots):
            continue
        if plain is None:
            plain = build_material("cv_neutral", NEUTRAL, "#cccccc")
        assign_material(ob, plain)
        done += 1
    return done


def apply_edits(mapping):
    """Move, rotate, scale and restyle individual parts before export.

    Each edit is a delta on the part's own local transform -- the same thing the
    viewer's gizmo manipulates -- so it composes with whatever pose the part was
    authored with instead of replacing it. Rotation and scale therefore pivot on
    the part's origin, exactly as they appeared on screen.

    Returns ``(applied, styled, missing)``: a name with no object behind it is
    reported rather than passed over, because silently exporting an unedited
    model is the one outcome the user cannot tell from a bug.
    """
    if not mapping:
        return 0, 0, []

    applied = 0
    styled = 0
    missing = []
    for name, edit in sorted(mapping.items()):
        ob = bpy.data.objects.get(name)
        if ob is None or not isinstance(edit, dict):
            missing.append(name)
            continue

        move = to_blender_vector(edit.get("move") or (0.0, 0.0, 0.0))
        degrees = edit.get("rotate") or (0.0, 0.0, 0.0)
        spin = to_blender_quaternion(
            Euler([math.radians(a) for a in degrees], "XYZ").to_quaternion())
        factor = to_blender_scale(edit.get("scale") or (1.0, 1.0, 1.0))

        # The glTF node transform is the parent inverse folded into the basis,
        # so the delta is applied there and folded back out. For an unparented
        # object the parent inverse is the identity and this is just the basis.
        node = ob.matrix_parent_inverse @ ob.matrix_basis
        location, rotation, scale = node.decompose()
        ob.matrix_basis = ob.matrix_parent_inverse.inverted() @ Matrix.LocRotScale(
            location + move,
            rotation @ spin,
            Vector((scale[i] * factor[i] for i in range(3))),
        )
        applied += 1

        kind = edit.get("material") or ""
        alpha = edit.get("opacity")
        alpha = 1.0 if alpha is None else max(0.0, min(1.0, float(alpha)))
        if kind in MATERIALS:
            mat = build_material(ob.name + "_material", MATERIALS[kind],
                                 edit.get("color") or "#cccccc", alpha,
                                 edit.get("metalness"), edit.get("roughness"))
            hit = assign_material(ob, mat)
            for child in ob.children_recursive:
                hit = assign_material(child, mat) or hit
            styled += 1 if hit else 0
        else:
            # No preset: fade and recolour what the part already wears, rather
            # than standing something else in front of it.
            tint = edit.get("color") if edit.get("recolor") else None
            if alpha < 1.0 or tint is not None:
                hit = fade_object(ob, alpha, tint)
                for child in ob.children_recursive:
                    hit = fade_object(child, alpha, tint) or hit
                styled += 1 if hit else 0

    bpy.context.view_layer.update()
    return applied, styled, missing


# --- animation ---------------------------------------------------------------
# Clips are authored in the browser as keyframes -- a pose at a moment -- and
# baked here to one sample per frame. Baking, rather than keying and letting
# Blender interpolate, is what keeps the file matching the preview: the viewer
# blends poses its own way, and every exporter below samples the scene frame
# by frame anyway, so the frames are simply given the poses the viewer showed.

FPS = 30


def _shape(k, ease):
    """The fraction travelled, given the fraction of the way through in time.

    Mirrors ``shape`` in frontend/src/animation.ts. ``smooth`` is a smoothstep,
    leaving a key and arriving at the next one gently; ``hold`` does not travel,
    so the part sits at its key until the next one takes over.
    """
    if ease == "hold":
        return 0.0
    if ease == "smooth":
        return k * k * (3.0 - 2.0 * k)
    return k


def sample_pose(keys, t):
    """The pose a track is in ``t`` seconds in: held before the first key and
    after the last, blended between neighbours along the earlier key's ease.

    Mirrors ``poseAt`` in frontend/src/animation.ts, which is what the viewer
    drew -- the two have to agree or the file plays differently from the preview.
    """
    if t <= keys[0]["time"]:
        return keys[0]
    if t >= keys[-1]["time"]:
        return keys[-1]
    for a, b in zip(keys, keys[1:]):
        if t <= b["time"]:
            break
    span = b["time"] - a["time"]
    k = 0.0 if span <= 0 else (t - a["time"]) / span
    k = _shape(k, a.get("ease"))
    return {
        field: [a[field][i] + (b[field][i] - a[field][i]) * k for i in range(3)]
        for field in ("move", "rotate", "scale")
    }


def write_samples(bag, rest, keys, frames):
    """Bake one track onto a channelbag: a location, rotation and scale key on
    every frame from 0 to ``frames`` inclusive, frame 0 being the clip's start.

    ``rest`` is the node transform the deltas are laid on -- the part's pose as
    the preview showed it, edits included -- with its parent inverse, so a part
    that is the child of another composes the same way ``apply_edits`` does.
    """
    parent_inverse, node = rest
    to_basis = parent_inverse.inverted()
    location, rotation, scale = node.decompose()

    columns = {("location", i): [] for i in range(3)}
    columns.update({("rotation_quaternion", i): [] for i in range(4)})
    columns.update({("scale", i): [] for i in range(3)})
    previous = None
    for frame in range(frames + 1):
        pose = sample_pose(keys, frame / FPS)
        move = to_blender_vector(pose["move"])
        spin = to_blender_quaternion(
            Euler([math.radians(a) for a in pose["rotate"]], "XYZ").to_quaternion())
        factor = to_blender_scale(pose["scale"])
        basis = to_basis @ Matrix.LocRotScale(
            location + move,
            rotation @ spin,
            Vector((scale[i] * factor[i] for i in range(3))),
        )
        loc, quat, size = basis.decompose()
        # q and -q are the same turn, but Blender blends between frames by
        # component, so a sign flip between neighbours would whip the part
        # round the long way.
        if previous is not None and previous.dot(quat) < 0:
            quat = -quat
        previous = quat
        for i in range(3):
            columns[("location", i)].append(loc[i])
            columns[("scale", i)].append(size[i])
        for i in range(4):
            columns[("rotation_quaternion", i)].append(quat[i])

    count = frames + 1
    for (path, index), values in columns.items():
        curve = bag.fcurves.new(path, index=index)
        curve.keyframe_points.add(count)
        flat = [0.0] * (2 * count)
        flat[0::2] = range(count)
        flat[1::2] = values
        curve.keyframe_points.foreach_set("co", flat)
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"
        curve.update()


def make_model_root(name, pivot):
    """An empty every root object hangs from, for animating the model as one.

    Put at the pivot the viewer turned the model about, so a rotation keyed
    there swings the model about its own centre in the file too. The children
    keep their world transforms through the reparenting.
    """
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    root.location = to_blender_vector(pivot or (0.0, 0.0, 0.0))
    bpy.context.view_layer.update()
    inverse = root.matrix_world.inverted()
    for ob in list(bpy.data.objects):
        if ob is root or ob.parent is not None:
            continue
        ob.parent = root
        ob.matrix_parent_inverse = inverse
    bpy.context.view_layer.update()
    return root


def park_existing_animation():
    """Move every active action onto the NLA, and say where the animation the
    file arrived with ends.

    Assigning a clip as an object's active action would replace the one it was
    imported with; on a strip it survives, and the glTF exporter still writes
    it as an animation of its own. The end frame is where the new clips are
    laid down from, so on a single timeline they follow the original rather
    than playing over it.
    """
    end = 0.0
    for ob in bpy.data.objects:
        ad = ob.animation_data
        if ad is None:
            continue
        if ad.action is not None:
            action = ad.action
            start = int(math.floor(action.frame_range[0]))
            strip = ad.nla_tracks.new().strips.new(action.name, start, action)
            if ad.action_slot is not None:
                strip.action_slot = ad.action_slot
            ad.action = None
        for track in ad.nla_tracks:
            for strip in track.strips:
                end = max(end, strip.frame_end)
    return int(math.ceil(end)) + 1 if end > 0 else 0


REST_KEY = {"time": 0.0, "move": [0.0, 0.0, 0.0], "rotate": [0.0, 0.0, 0.0],
            "scale": [1.0, 1.0, 1.0]}


def new_action(name):
    action = bpy.data.actions.new(name)
    layer = action.layers.new("Layer")
    layer.strips.new(type="KEYFRAME")
    return action


def add_strip(ob, name, action, slot, start, extrapolation):
    """Put ``action`` on a fresh NLA track of its own, which is the arrangement
    the glTF exporter reads: one strip per track."""
    track = ob.animation_data_create().nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, start, action)
    strip.action_slot = slot
    strip.extrapolation = extrapolation
    return strip


def apply_clips(clips, root_name, sequential):
    """Key every clip onto the parts it animates, one action per clip.

    Every part a clip moves gets a slot in that clip's action, so the glTF
    exporter -- which merges by action -- writes one named animation per clip,
    however many parts it moves.

    Where the strips go depends on who reads them. glTF reads the actions and
    ignores the timeline, so every clip starts at frame 0. The formats that
    sample the scene instead -- USD, FBX, Alembic -- know nothing of clips, so
    for them (``sequential``) the clips are laid end to end, with a held rest
    strip beneath each part so it sits still outside its own clips. The rest
    strip is not written for glTF, where it would come out as a clip of its own.

    A part is only ever at rest *because* something says so: an animated channel
    that no strip covers evaluates to the property's default -- the origin, not
    the part's own place -- which is also why for glTF nothing may start later
    than frame 0, where the exporter reads each node's still transform.

    Returns ``(keyed, missing)``: how many part-tracks were written, and the
    targets no object answered to.
    """
    if not clips:
        return 0, []

    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    existing_end = park_existing_animation()
    frame = existing_end if sequential else 0
    last = frame

    rest = {}
    rest_action = None
    root = None
    keyed = 0
    missing = []
    for clip in clips:
        frames = max(1, int(round(float(clip["duration"]) * FPS)))
        action = new_action(clip["name"])
        for track in clip["tracks"]:
            target = track["target"]
            if target == "":
                if root is None:
                    root = make_model_root(root_name, track.get("pivot"))
                ob = root
            else:
                ob = bpy.data.objects.get(target)
                if ob is None:
                    missing.append(target)
                    continue
            # The rest pose is read once, before any clip has touched the
            # object: a second clip is a delta on the same pose as the first.
            if ob.name not in rest:
                rest[ob.name] = (ob.matrix_parent_inverse.copy(),
                                 ob.matrix_parent_inverse @ ob.matrix_basis)
                ob.rotation_mode = "QUATERNION"
                if sequential:
                    if rest_action is None:
                        rest_action = new_action("Rest")
                    slot = rest_action.slots.new(id_type="OBJECT", name=ob.name)
                    write_samples(rest_action.layers[0].strips[0].channelbag(slot, ensure=True),
                                  rest[ob.name], [REST_KEY], 1)
                    add_strip(ob, "Rest", rest_action, slot, 0, "HOLD")
            slot = action.slots.new(id_type="OBJECT", name=ob.name)
            write_samples(action.layers[0].strips[0].channelbag(slot, ensure=True),
                          rest[ob.name], track["keys"], frames)
            add_strip(ob, clip["name"], action, slot, frame, "NOTHING")
            keyed += 1
        last = max(last, frame + frames)
        if sequential:
            frame += frames + 1

    scene.frame_start = 0
    scene.frame_end = max(last, 1)
    scene.frame_set(0)
    return keyed, sorted(set(missing))


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


# --- compression -------------------------------------------------------------
# A mesh below this many triangles is left alone by the triangle budget. A flat
# percentage is brutal to small parts: 30% of a 200-triangle bolt is a lump,
# while the same 30% barely touches a 500k-triangle body. Protecting the small
# ones and taking the reduction out of the large ones spends the budget where
# the triangles actually are.
BUDGET_FLOOR = 64


def triangle_counts():
    """Evaluated triangle count per mesh object, so modifiers already set count."""
    return {name: tris for name, _, tris in mesh_counts()}


def apply_tri_budget(budget):
    """Decimate towards a total triangle count rather than a blind percentage.

    Returns ``(ratio, touched, before)``. The result is approximate: the
    Decimate modifier's ratio is over faces and collapsing is topology-bound,
    so a mesh can land somewhat above its share.
    """
    counts = triangle_counts()
    total = sum(counts.values())
    if not total or total <= budget:
        return None, 0, total

    protected = sum(t for t in counts.values() if t <= BUDGET_FLOOR)
    reducible = total - protected
    room = budget - protected
    if reducible <= 0:
        return None, 0, total
    # Everything large shares one ratio, which keeps their relative detail.
    ratio = min(1.0, max(0.01, room / reducible))

    touched = 0
    for ob in bpy.data.objects:
        if ob.type != "MESH" or counts.get(ob.name, 0) <= BUDGET_FLOOR:
            continue
        m = ob.modifiers.new("cv_budget", "DECIMATE")
        m.ratio = ratio
        touched += 1
    return ratio, touched, total


def apply_weld(threshold):
    """Merge vertices closer together than ``threshold`` model units."""
    if threshold <= 0:
        return 0
    welded = 0
    for ob in bpy.data.objects:
        if ob.type == "MESH" and ob.data.vertices:
            m = ob.modifiers.new("cv_weld", "WELD")
            m.mode = "ALL"
            m.merge_threshold = threshold
            welded += 1
    return welded


def apply_clean():
    """Drop unused material slots and loose geometry.

    Both are safe: a slot no face points at contributes nothing, and a vertex
    or edge belonging to no face is invisible in every renderer while still
    costing bytes in the file.
    """
    slots = 0
    loose = 0
    for ob in list(bpy.data.objects):
        if ob.type != "MESH":
            continue
        me = ob.data

        used = {p.material_index for p in me.polygons}
        # Walk high-to-low so removing one slot cannot shift the next index.
        for i in range(len(ob.material_slots) - 1, -1, -1):
            if i in used or len(ob.material_slots) <= 1:
                continue
            ob.active_material_index = i
            try:
                with bpy.context.temp_override(object=ob):
                    bpy.ops.object.material_slot_remove()
                slots += 1
            except Exception:
                pass

        # delete_loose works over the whole mesh, so no selection is needed.
        # Only meshes that have faces: for a point cloud or a curve-turned-edge
        # loop, every vertex is "loose" and deleting them empties the object.
        if not me.polygons:
            continue
        before = len(me.vertices) + len(me.edges)
        try:
            with bpy.context.temp_override(object=ob, active_object=ob,
                                           selected_objects=[ob],
                                           selected_editable_objects=[ob]):
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True,
                                          use_faces=False)
                bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            if ob.mode != "OBJECT":
                try:
                    bpy.ops.object.mode_set(mode="OBJECT")
                except Exception:
                    pass
        loose += max(0, before - (len(me.vertices) + len(me.edges)))
    return slots, loose


def apply_merge(mode):
    """Join mesh objects together, cutting mesh and draw-call count.

    ``material`` joins the meshes that share a single material into one object
    each -- the shape that batches well while still splitting by look.
    ``all`` collapses everything into one mesh. Either way the individual part
    names are gone, which is why the caller refuses to do this to a model that
    carries animation.
    """
    meshes = [ob for ob in bpy.data.objects if ob.type == "MESH"]
    if mode == "none" or len(meshes) < 2:
        return 0, len(meshes)
    before = len(meshes)

    if mode == "all":
        groups = [meshes]
    else:
        by_mat = {}
        for ob in meshes:
            names = tuple(sorted(
                s.material.name for s in ob.material_slots if s.material))
            by_mat.setdefault(names, []).append(ob)
        groups = list(by_mat.values())

    for group in groups:
        if len(group) < 2:
            continue
        # Join writes into the active object, so it has to be one of the group
        # and every member has to be selected.
        bpy.ops.object.select_all(action="DESELECT")
        for ob in group:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        try:
            bpy.ops.object.join()
        except Exception as exc:
            emit("warn", message="could not join " + str(len(group))
                 + " mesh(es): " + str(exc))
    bpy.ops.object.select_all(action="DESELECT")
    return before, len([ob for ob in bpy.data.objects if ob.type == "MESH"])


def _image_roles():
    """Which images feed an Alpha socket or a Normal Map node.

    Lossy re-encoding ruins both: a JPEG alpha channel does not exist at all,
    and JPEG's chroma blocking turns a normal map's smooth gradients into
    faceted shading. The resolution cap still applies to them.
    """
    alpha = set()
    normal = set()
    for mat in bpy.data.materials:
        tree = mat.node_tree
        if not tree:
            continue
        for node in tree.nodes:
            if node.bl_idname != "ShaderNodeTexImage" or not node.image:
                continue
            name = node.image.name
            for out in node.outputs:
                if out.name == "Alpha" and out.is_linked:
                    alpha.add(name)
            for out in node.outputs:
                if out.name != "Color" or not out.is_linked:
                    continue
                for link in out.links:
                    if link.to_node.bl_idname == "ShaderNodeNormalMap":
                        normal.add(name)
    return alpha, normal


_IMAGE_EXT = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}


def compress_textures(limit, fmt, quality, tex_dir):
    """Cap texture resolution and optionally re-encode, then repoint the images.

    Scaling in memory is not enough on its own: the OBJ, FBX and USD exporters
    copy the image *file* rather than re-encoding it, so a scaled image would
    export at its original size. Writing the scaled pixels to ``tex_dir`` and
    pointing the datablock there makes every exporter carry the smaller file.
    """
    if limit <= 0 and fmt == "auto":
        return 0, 0, 0

    alpha, normal = _image_roles()
    os.makedirs(tex_dir, exist_ok=True)
    scaled = 0
    recoded = 0
    skipped = 0

    for im in list(bpy.data.images):
        w, h = im.size
        if not w or not h or im.type != "IMAGE":
            continue

        want_scale = limit > 0 and max(w, h) > limit
        # Alpha and normal maps keep whatever they were authored as.
        lossy_ok = im.name not in alpha and im.name not in normal
        want_recode = fmt != "auto" and lossy_ok
        # Counted whether or not the image is resized as well, so the tally
        # means "images a re-encode was not applied to" and does not drift
        # with an unrelated change to the resolution cap.
        if fmt != "auto" and not lossy_ok:
            skipped += 1
        if not want_scale and not want_recode:
            continue

        target_fmt = {"jpeg": "JPEG", "webp": "WEBP"}.get(fmt) if want_recode else None
        if target_fmt is None:
            # Scaling only: keep a format Blender can write back losslessly.
            target_fmt = im.file_format if im.file_format in _IMAGE_EXT else "PNG"

        try:
            if want_scale:
                factor = float(limit) / max(w, h)
                im.scale(max(1, int(round(w * factor))), max(1, int(round(h * factor))))
                scaled += 1

            safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in im.name)
            path = os.path.join(tex_dir, safe + _IMAGE_EXT[target_fmt])
            if im.packed_file:
                im.unpack(method="REMOVE")
            im.file_format = target_fmt
            im.filepath_raw = path
            im.save(quality=quality)
            # Reload so the datablock is backed by the file the exporter copies.
            im.reload()
            if want_recode:
                recoded += 1
        except Exception as exc:
            emit("warn", message="could not compress texture '" + im.name
                 + "': " + str(exc))
    return scaled, recoded, skipped


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

    dropped, gone = apply_removals(o.get("remove") or [])
    if dropped:
        emit("info", message="Removed " + str(dropped) + " object(s)")
    warn_missing(gone, "those parts were not removed")
    if not bpy.data.objects:
        emit("error", message="every part was removed -- nothing left to export")
        sys.exit(3)

    edited, styled, missing = apply_edits(o.get("edits") or {})
    if edited:
        emit("info", message="Edited " + str(edited) + " part(s)")
    warn_missing(missing, "those edits were not applied")
    # OBJ carries materials as a running state, so an unstyled part written
    # after a styled one would inherit its colour. Only worth the extra
    # materials when something actually was styled.
    if styled and dst_ext == ".obj":
        filled = backfill_materials()
        if filled:
            emit("info", message="Gave " + str(filled) + " unstyled part(s) a plain material")

    renamed = apply_renames(o.get("renames") or {})
    if renamed:
        emit("info", message="Renamed " + str(renamed) + " part(s)")

    applies_modifiers = bool(o.get("apply_modifiers", True))
    reductions = [name for name, on in (
        ("Simplify", 0.0 < float(o.get("decimate", 1.0)) < 1.0),
        ("the triangle budget", int(o.get("tri_budget", 0) or 0) > 0),
        ("Merge vertices", float(o.get("weld", 0.0)) > 0),
        ("Triangulate faces", bool(o.get("triangulate"))),
    ) if on]

    emit("progress", pct=45, step="Transforming")
    apply_scale(float(o.get("scale", 1.0)))
    apply_center(o.get("center", "none"))
    keyed, unmoved = apply_clips(
        o.get("clips") or [], os.path.splitext(os.path.basename(dst))[0],
        sequential=dst_ext not in (".glb", ".gltf"))
    if keyed:
        emit("info", message="Keyed " + str(keyed) + " part-track(s) across "
             + str(len(o.get("clips") or [])) + " clip(s)")
    warn_missing(unmoved, "those parts were not animated")
    emit("progress", pct=52, step="Reducing")
    if not applies_modifiers and reductions:
        # Every one of these is a modifier, and the exporters are being told
        # not to apply modifiers -- so they would be silently dropped.
        emit("warn", message="'Apply modifiers' is off, so "
             + ", ".join(reductions) + " could not be written into the file. "
             "Turn it on to keep the reduction.")

    if o.get("clean"):
        slots, loose = apply_clean()
        if slots or loose:
            emit("info", message="Cleaned " + str(slots) + " unused material slot(s) and "
                 + str(loose) + " loose vert/edge(s)")

    welded = apply_weld(float(o.get("weld", 0.0)))
    if welded:
        emit("info", message="Merged vertices within "
             + str(o.get("weld")) + " on " + str(welded) + " mesh(es)")

    merge = o.get("merge", "none")
    if merge != "none" and o.get("clips"):
        # Animation lives on objects; joining them would keep only one object's
        # action and silently drop the rest of the clip.
        emit("warn", message="Meshes were not merged: the model carries animation, "
                             "which is held per part and would be lost in the join")
    elif merge != "none":
        before, after = apply_merge(merge)
        if before and before != after:
            emit("info", message="Merged " + str(before) + " mesh(es) into " + str(after))

    if o.get("triangulate"):
        apply_triangulate()

    budget = int(o.get("tri_budget", 0) or 0)
    if budget > 0:
        # A budget is a target, so it stands in for the flat percentage.
        ratio, touched, total = apply_tri_budget(budget)
        if ratio is None:
            emit("info", message="Already within the " + str(budget)
                 + "-triangle budget (" + str(total) + ")")
        else:
            emit("info", message="Budget " + str(budget) + " of " + str(total)
                 + " triangles: decimating " + str(touched) + " mesh(es) to "
                 + str(round(ratio * 100, 1)) + "%")
    else:
        apply_decimate(float(o.get("decimate", 1.0)))

    tex_limit = int(o.get("texture_limit", 0) or 0)
    tex_format = o.get("texture_format", "auto")
    if bpy.data.images and (tex_limit > 0 or tex_format != "auto"):
        emit("progress", pct=56, step="Compressing textures")
        scaled, recoded, skipped = compress_textures(
            tex_limit, tex_format, int(o.get("texture_quality", 85)),
            os.path.join(cfg["work"], "_tex"))
        if scaled or recoded:
            emit("info", message="Textures: " + str(scaled) + " resized, "
                 + str(recoded) + " re-encoded to " + tex_format.upper())
        if skipped:
            emit("info", message=str(skipped) + " texture(s) kept their format: "
                                 "alpha and normal maps do not survive lossy encoding")

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

    # Counted the way the exporter wrote it, so the before/after the user
    # sees is the file they are about to download.
    emit("stats", result=scene_stats(evaluated=applies_modifiers))
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
