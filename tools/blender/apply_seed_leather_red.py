"""
Apply Poly Haven leather_red_03 to the Chennamane seed GLB via Blender.

- Imports public/models/seed.glb
- Loads maps from public/textures/seed/
- Sphere-friendly UV + fine-scale mapping for micro grain on beads
- Exports public/models/seed.glb (Y-up)

https://polyhaven.com/a/leather_red_03
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy


def project_root() -> Path:
    for a in sys.argv:
        if a.endswith("apply_seed_leather_red.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
SEED_GLB = ROOT / "public" / "models" / "seed.glb"
TEX = ROOT / "public" / "textures" / "seed"
OUT_GLB = SEED_GLB


def clear_scene() -> None:
    """Delete every object (including empties from glTF) and orphan data."""
    # Unlink from all collections first
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.textures, bpy.data.cameras, bpy.data.lights):
        for b in list(coll):
            try:
                coll.remove(b)
            except Exception:
                pass


def load_image(path: Path, name: str, non_color: bool = False) -> bpy.types.Image:
    if name in bpy.data.images:
        img = bpy.data.images[name]
        try:
            if img.filepath and Path(bpy.path.abspath(img.filepath)).exists():
                return img
        except Exception:
            pass
    img = bpy.data.images.load(str(path), check_existing=True)
    img.name = name
    try:
        img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    except Exception:
        pass
    return img


def make_seed_material() -> bpy.types.Material:
    """SeedGulaganji — leather_red_03 PBR, glossy red bead."""
    name = "SeedCoral"
    if name in bpy.data.materials:
        mat = bpy.data.materials[name]
    else:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (420, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (120, 0)
    bsdf.inputs["Roughness"].default_value = 0.28
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.55
        bsdf.inputs["Coat Roughness"].default_value = 0.16
    # Slight warm tint multiply keeps red vivid under indoor light
    if "Base Color" in bsdf.inputs:
        bsdf.inputs["Base Color"].default_value = (1.0, 0.35, 0.28, 1.0)

    texcoord = nodes.new("ShaderNodeTexCoord")
    texcoord.location = (-820, 0)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-600, 0)
    mapping.vector_type = "TEXTURE"
    # Fine scale so leather grain reads as micro-detail on ~2 cm beads
    mapping.inputs["Scale"].default_value = (4.0, 4.0, 4.0)
    links.new(texcoord.outputs["UV"], mapping.inputs["Vector"])

    def tex_node(img: bpy.types.Image, y: float) -> bpy.types.ShaderNodeTexImage:
        n = nodes.new("ShaderNodeTexImage")
        n.image = img
        n.location = (-360, y)
        links.new(mapping.outputs["Vector"], n.inputs["Vector"])
        return n

    diff = load_image(TEX / "seed_diff.jpg", "leather_red_03_diff", non_color=False)
    nor = load_image(TEX / "seed_nor_gl.jpg", "leather_red_03_nor", non_color=True)
    rough = load_image(TEX / "seed_rough.jpg", "leather_red_03_rough", non_color=True)

    n_diff = tex_node(diff, 200)
    n_nor = tex_node(nor, 0)
    n_rough = tex_node(rough, -200)

    # Brighten red albedo slightly for board contrast (Blender 4+ Mix node)
    try:
        mix = nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.location = (-80, 180)
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["B"].default_value = (1.15, 0.55, 0.45, 1.0)
        links.new(n_diff.outputs["Color"], mix.inputs["A"])
        links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    except Exception:
        mix = nodes.new("ShaderNodeMixRGB")
        mix.location = (-80, 180)
        mix.blend_type = "MULTIPLY"
        mix.inputs["Fac"].default_value = 1.0
        mix.inputs["Color2"].default_value = (1.15, 0.55, 0.45, 1.0)
        links.new(n_diff.outputs["Color"], mix.inputs["Color1"])
        links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])

    links.new(n_rough.outputs["Color"], bsdf.inputs["Roughness"])

    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-80, -40)
    normal_map.inputs["Strength"].default_value = 0.55
    links.new(n_nor.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def sphere_uv(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.sphere_project(direction="VIEW_ON_EQUATOR", align="POLAR_ZX", correct_aspect=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def main() -> None:
    if not SEED_GLB.exists():
        raise FileNotFoundError(SEED_GLB)
    for f in ("seed_diff.jpg", "seed_nor_gl.jpg", "seed_rough.jpg"):
        if not (TEX / f).exists():
            raise FileNotFoundError(TEX / f)

    clear_scene()
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=str(SEED_GLB))
    imported = [bpy.data.objects[n] for n in set(bpy.data.objects.keys()) - before]
    meshes = [o for o in imported if o.type == "MESH"]
    if not meshes:
        # Fallback if names collided — take mesh with fewest verts (seed ~400, not plants)
        meshes = [o for o in bpy.data.objects if o.type == "MESH"]
        meshes.sort(key=lambda o: len(o.data.vertices))
    if not meshes:
        raise RuntimeError("No mesh in seed.glb")
    seed = meshes[0]
    # Prefer object named Sphere / Seed
    for o in meshes:
        if "seed" in o.name.lower() or "sphere" in o.name.lower():
            seed = o
            break
    # Safety: seed must be tiny (~2 cm radius), not a plant
    if len(seed.data.vertices) > 5000:
        raise RuntimeError(
            f"Refusing to treat large mesh as seed: {seed.name} verts={len(seed.data.vertices)}"
        )

    print("SEED", seed.name, "verts", len(seed.data.vertices))
    mat = make_seed_material()
    seed.data.materials.clear()
    seed.data.materials.append(mat)
    sphere_uv(seed)
    bpy.ops.object.shade_smooth()

    # Export only the seed mesh
    bpy.ops.object.select_all(action="DESELECT")
    seed.select_set(True)
    bpy.context.view_layer.objects.active = seed
    bpy.ops.export_scene.gltf(
        filepath=str(OUT_GLB),
        use_selection=True,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_jpeg_quality=85,
    )
    size = OUT_GLB.stat().st_size
    if size < 1000:
        raise RuntimeError(f"Export too small ({size} bytes) — aborted corrupt write")
    print("EXPORTED", OUT_GLB, size)


if __name__ == "__main__":
    main()
