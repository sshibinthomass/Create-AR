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


FORMATS: tuple[Format, ...] = (
    # --- realtime / AR delivery ---
    Format(".glb", "glTF Binary", "mesh", "blender", True, True,
           "model/gltf-binary", "Best for web and Android AR. Supports Draco compression."),
    Format(".gltf", "glTF Separate", "mesh", "blender", True, True,
           "model/gltf+json", "Emits .gltf + .bin + textures; downloaded as a .zip."),
    Format(".usdz", "USDZ", "scene", "blender", True, True,
           "model/vnd.usdz+zip", "Apple AR Quick Look. Exported Y-up for ARKit."),
    Format(".usdc", "USD Binary", "scene", "blender", True, True,
           "model/vnd.usd", ""),
    Format(".usda", "USD ASCII", "scene", "blender", True, True,
           "model/vnd.usd", ""),
    Format(".usd", "USD", "scene", "blender", True, True, "model/vnd.usd", ""),

    # --- DCC interchange ---
    Format(".fbx", "Autodesk FBX", "mesh", "blender", True, True,
           "application/octet-stream", "Textures embedded when present."),
    Format(".obj", "Wavefront OBJ", "mesh", "blender", True, True,
           "model/obj", "Emits .obj + .mtl + textures; downloaded as a .zip."),
    Format(".abc", "Alembic", "scene", "blender", True, True,
           "application/octet-stream", "Baked geometry cache."),
    Format(".blend", "Blender", "scene", "blender", True, False,
           "application/octet-stream", "Accepted as input only."),

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
)

BY_EXT: dict[str, Format] = {f.ext: f for f in FORMATS}

# Extensions that mean the same thing as a canonical one.
ALIASES: dict[str, str] = {
    ".stp": ".step",
    ".igs": ".iges",
}

CAD_EXTS = {f.ext for f in FORMATS if f.category == "cad"}

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


def describe() -> dict:
    """Capability payload consumed by the frontend to build its pickers."""
    return {
        "formats": [asdict(f) for f in FORMATS],
        "aliases": ALIASES,
        "inputs": input_exts(),
        "outputs": output_exts(),
    }
