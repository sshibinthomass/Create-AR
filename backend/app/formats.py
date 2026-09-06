"""The single source of truth for what this service can read and write.

Capabilities were verified against Blender 5.2's operator table -- notably
Collada (.dae) is *absent*, having been removed in Blender 5.x, and STEP/IGES
are handled by OpenCASCADE (cascadio) rather than Blender.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Format:
    ext: str            # canonical extension, with leading dot
    label: str          # human name for the UI
    category: str       # mesh | cad | scene
    engine: str         # blender | opencascade
    can_import: bool
    can_export: bool
    mime: str
    note: str = ""
    # Whether the exporter can write keyframe animation into this format.
    # OBJ, STL and PLY describe a single still; the rest carry a timeline.
    can_animate: bool = False


FORMATS: tuple[Format, ...] = (
    # --- realtime / AR delivery ---
    Format(".glb", "glTF Binary", "mesh", "blender", True, True,
           "model/gltf-binary", "Best for web and Android AR. Supports Draco compression.",
           can_animate=True),
    Format(".gltf", "glTF Separate", "mesh", "blender", True, True,
           "model/gltf+json", "Emits .gltf + .bin + textures; downloaded as a .zip.",
           can_animate=True),
    Format(".usdz", "USDZ", "scene", "blender", True, True,
           "model/vnd.usdz+zip", "Apple AR Quick Look. Exported Y-up for ARKit.",
           can_animate=True),
    Format(".usdc", "USD Binary", "scene", "blender", True, True,
           "model/vnd.usd", "", can_animate=True),
    Format(".usda", "USD ASCII", "scene", "blender", True, True,
           "model/vnd.usd", "", can_animate=True),
    Format(".usd", "USD", "scene", "blender", True, True, "model/vnd.usd", "",
           can_animate=True),

    # --- DCC interchange ---
    Format(".fbx", "Autodesk FBX", "mesh", "blender", True, True,
           "application/octet-stream", "Textures embedded when present.", can_animate=True),
    Format(".obj", "Wavefront OBJ", "mesh", "blender", True, True,
           "model/obj", "Emits .obj + .mtl + textures; downloaded as a .zip."),
    Format(".abc", "Alembic", "scene", "blender", True, True,
           "application/octet-stream", "Baked geometry cache.", can_animate=True),
    Format(".blend", "Blender", "scene", "blender", True, False,
           "application/octet-stream", "Accepted as input only.", can_animate=True),

    # --- mesh / printing ---
    Format(".stl", "STL", "mesh", "blender", True, True,
           "model/stl", "Geometry only -- no materials or UVs."),
    Format(".ply", "PLY", "mesh", "blender", True, True,
           "model/mesh", "Supports vertex colours."),

    # --- CAD (OpenCASCADE tessellation on the way in) ---
    Format(".step", "STEP (AP203/214/242)", "cad", "opencascade", True, False,
           "model/step", "B-rep is tessellated on import; tolerance is adjustable."),
    Format(".iges", "IGES", "cad", "opencascade", True, False,
           "model/iges", "B-rep is tessellated on import; tolerance is adjustable."),

    # --- archives (a bundle of one of the above plus its textures) ---
    Format(".zip", "Zip archive", "archive", "archive", True, False,
           "application/zip",
           "Model plus its textures and sidecars. The model is found automatically."),
    Format(".7z", "7-Zip archive", "archive", "archive", True, False,
           "application/x-7z-compressed", "Unpacked the same way as .zip."),
    Format(".tar", "Tar archive", "archive", "archive", True, False,
           "application/x-tar", "Also .tar.gz / .tgz / .tar.bz2 / .tar.xz."),
)

BY_EXT: dict[str, Format] = {f.ext: f for f in FORMATS}

# Extensions that mean the same thing as a canonical one.
ALIASES: dict[str, str] = {
    ".stp": ".step",
    ".igs": ".iges",
    # Compressed tarballs: Path.suffix only sees the trailing part.
    ".tgz": ".tar",
    ".gz": ".tar",
    ".bz2": ".tar",
    ".xz": ".tar",
    ".tbz": ".tar",
    ".txz": ".tar",
}

# Model formats we recognise but cannot import. Naming them beats a bare
# "unsupported": the file plainly is a model, so the useful answer is which
# download to fetch instead. These are what a marketplace hands out as the
# author's original "source" upload, Collada most often of all.
UNSUPPORTED_INPUTS: dict[str, tuple[str, str]] = {
    ".dae": ("COLLADA",
             "Blender 5.x removed the Collada importer. Download the glTF or "
             "GLB version instead -- Collada exports also tend to drop their "
             "texture bindings, so the .glb is the better file anyway."),
    ".3ds": ("3D Studio", "Re-export it as .glb, .fbx or .obj."),
    ".max": ("3ds Max", "A .max file only opens in 3ds Max. "
                        "Re-export it as .glb, .fbx or .obj."),
    ".c4d": ("Cinema 4D", "A .c4d file only opens in Cinema 4D. "
                          "Re-export it as .glb, .fbx or .obj."),
    ".skp": ("SketchUp", "Re-export it as .glb, .fbx or .obj."),
}

CAD_EXTS = {f.ext for f in FORMATS if f.category == "cad"}
ARCHIVE_EXTS = {f.ext for f in FORMATS if f.category == "archive"}

# Output formats that fan out into several files and must be zipped.
MULTIFILE_EXTS = {".obj", ".gltf"}


def canonical(ext: str) -> str:
    """Normalise an extension: lowercase, leading dot, aliases resolved."""
    ext = ext.lower().strip()
    if not ext.startswith("."):
        ext = "." + ext
    return ALIASES.get(ext, ext)


def input_exts() -> list[str]:
    """Every extension accepted for upload, aliases included."""
    base = [f.ext for f in FORMATS if f.can_import]
    return sorted(base + [a for a, target in ALIASES.items() if BY_EXT[target].can_import])


def output_exts() -> list[str]:
    return [f.ext for f in FORMATS if f.can_export]


def is_supported_input(ext: str) -> bool:
    fmt = BY_EXT.get(canonical(ext))
    return bool(fmt and fmt.can_import)


def is_supported_output(ext: str) -> bool:
    fmt = BY_EXT.get(canonical(ext))
    return bool(fmt and fmt.can_export)


def can_animate(ext: str) -> bool:
    """Whether a file of this format can carry the animations authored in the app."""
    fmt = BY_EXT.get(canonical(ext))
    return bool(fmt and fmt.can_export and fmt.can_animate)


def animated_exts() -> list[str]:
    return [f.ext for f in FORMATS if f.can_export and f.can_animate]


def unsupported_note(ext: str) -> str | None:
    """Why ``ext`` is refused and what to supply instead, if we recognise it."""
    entry = UNSUPPORTED_INPUTS.get(canonical(ext))
    if entry is None:
        return None
    label, advice = entry
    return f"{label} ({canonical(ext)}) is not a supported input format. {advice}"


def describe() -> dict:
    """Capability payload consumed by the frontend to build its pickers."""
    return {
        "formats": [asdict(f) for f in FORMATS],
        "aliases": ALIASES,
        "inputs": input_exts(),
        "outputs": output_exts(),
    }
