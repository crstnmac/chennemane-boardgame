"""
Apply Poly Haven wood PBR maps to the Chennamane board via Blender.

Uses maps at public/textures/wood/wood_{diff,nor,rough}.jpg
(current: kitchen_wood — https://polyhaven.com/a/kitchen_wood).

- Imports public/models/board.glb
- Loads wood maps from public/textures/wood/
- Rebuilds UVs with cube projection (world-scale meters) so tiling is correct
- Assigns BoardWood material with PBR maps
- Exports public/models/board.glb (Y-up glTF)

Run via Blender MCP execute_code or:
  Blender --background --python tools/blender/apply_wood_table_worn.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def project_root() -> Path:
    for a in sys.argv:
        if a.endswith("apply_wood_table_worn.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
BOARD_GLB = ROOT / "public" / "models" / "board.glb"
TEX = ROOT / "public" / "textures" / "wood"
OUT_GLB = BOARD_GLB


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.textures):
        for b in list(coll):
            try:
                if b.users == 0:
                    coll.remove(b)
            except Exception:
                pass


def load_image(path: Path, name: str, non_color: bool = False) -> bpy.types.Image:
    # Prefer already-loaded
    if name in bpy.data.images:
        img = bpy.data.images[name]
        if img.filepath and Path(bpy.path.abspath(img.filepath)).exists():
            return img
    img = bpy.data.images.load(str(path), check_existing=True)
    img.name = name
    if non_color:
        try:
            img.colorspace_settings.name = "Non-Color"
        except Exception:
            pass
    else:
        try:
            img.colorspace_settings.name = "sRGB"
        except Exception:
            pass
    return img


def make_wood_material() -> bpy.types.Material:
    """BoardWood + kitchen_wood PBR (https://polyhaven.com/a/kitchen_wood)."""
    if "BoardWood" in bpy.data.materials:
        mat = bpy.data.materials["BoardWood"]
    else:
        mat = bpy.data.materials.new("BoardWood")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (100, 0)
    bsdf.inputs["Roughness"].default_value = 0.55
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.24
        bsdf.inputs["Coat Roughness"].default_value = 0.38

    # Mapping — world-scale UV from cube project (1 UV ≈ cube_size meters).
    texcoord = nodes.new("ShaderNodeTexCoord")
    texcoord.location = (-800, 0)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-600, 0)
    mapping.vector_type = "TEXTURE"
    mapping.inputs["Scale"].default_value = (1.5, 1.5, 1.5)
    links.new(texcoord.outputs["UV"], mapping.inputs["Vector"])

    def tex_node(img: bpy.types.Image, y: float) -> bpy.types.ShaderNodeTexImage:
        n = nodes.new("ShaderNodeTexImage")
        n.image = img
        n.location = (-350, y)
        links.new(mapping.outputs["Vector"], n.inputs["Vector"])
        return n

    diff = load_image(TEX / "wood_diff.jpg", "kitchen_wood_diff", non_color=False)
    nor = load_image(TEX / "wood_nor.jpg", "kitchen_wood_nor", non_color=True)
    rough = load_image(TEX / "wood_rough.jpg", "kitchen_wood_rough", non_color=True)

    n_diff = tex_node(diff, 200)
    n_nor = tex_node(nor, 0)
    n_rough = tex_node(rough, -200)

    links.new(n_diff.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(n_rough.outputs["Color"], bsdf.inputs["Roughness"])

    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-50, -50)
    normal_map.inputs["Strength"].default_value = 0.9
    links.new(n_nor.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def cube_uv(obj: bpy.types.Object, cube_size: float = 0.55) -> None:
    """
    World-aligned cube UVs so tileable Poly Haven wood maps correctly.
    cube_size: meters of mesh per UV unit (smaller = finer grain).
    """
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # Cube project uses active object bounds in edit mode
    bpy.ops.uv.cube_project(
        cube_size=cube_size,
        correct_aspect=True,
        clip_to_bounds=False,
        scale_to_bounds=False,
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def smart_uv(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def main() -> None:
    if not BOARD_GLB.exists():
        raise FileNotFoundError(BOARD_GLB)
    for f in ("wood_diff.jpg", "wood_nor.jpg", "wood_rough.jpg"):
        if not (TEX / f).exists():
            raise FileNotFoundError(TEX / f)

    clear_scene()
    # Import existing board
    bpy.ops.import_scene.gltf(filepath=str(BOARD_GLB))

    wood = None
    metal_objs = []
    for obj in list(bpy.data.objects):
        if obj.type != "MESH":
            continue
        name = obj.name.lower()
        # glTF may rename: BoardWoodMesh, BoardWood, etc.
        if "wood" in name and "board" in name:
            wood = obj
        elif "wood" in name and wood is None:
            wood = obj
        elif "metal" in name or "bronze" in name or "iron" in name or "cube" in name:
            metal_objs.append(obj)

    if wood is None:
        # Fallback: largest mesh
        meshes = [o for o in bpy.data.objects if o.type == "MESH"]
        wood = max(meshes, key=lambda o: len(o.data.vertices))
        print("FALLBACK wood object", wood.name)

    print("WOOD", wood.name, "verts", len(wood.data.vertices))

    wood_mat = make_wood_material()
    wood.data.materials.clear()
    wood.data.materials.append(wood_mat)

    # Cube-project wood for correct tileable placement (rosewood veneer scale)
    cube_uv(wood, cube_size=0.48)

    # Ensure metal parts keep valid UVs
    for mobj in metal_objs:
        if mobj == wood:
            continue
        smart_uv(mobj)

    # Export Y-up GLB for three.js (geometry + UVs; app still swaps studio materials)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.select_set(True)
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
    print("EXPORTED", OUT_GLB, OUT_GLB.stat().st_size)


if __name__ == "__main__":
    main()
