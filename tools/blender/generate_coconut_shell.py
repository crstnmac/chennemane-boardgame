"""
Generate a realistic open coconut shell for Chennamane score bowls.

Exports:
  public/models/coconut_shell.glb
  public/models/store_layout.json  (+ src/models/store_layout.json)

Materials (names used by Three.js studio pipeline):
  CoconutHusk  — fibrous outer shell
  CoconutFlesh — pale inner cavity

Run:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/generate_coconut_shell.py
"""

from __future__ import annotations

import json
import math
import traceback
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


def project_root() -> Path:
    import sys

    for a in sys.argv:
        if a.endswith("generate_coconut_shell.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
OUT = ROOT / "public" / "models"
OUT.mkdir(parents=True, exist_ok=True)
LAYOUT_SRC = ROOT / "src" / "models"
LAYOUT_SRC.mkdir(parents=True, exist_ok=True)
TEX = ROOT / "public" / "textures" / "coconut"

# Shell scale in meters (matches board ~1.1m long)
SHELL_R = 0.062
SHELL_DEPTH = 0.048
INNER_SCALE = 0.86
SEGMENTS = 64
RINGS = 32


def clear() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.textures):
        for b in list(coll):
            try:
                if b.users == 0:
                    coll.remove(b)
            except Exception:
                pass


def apply(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def load_image(path: Path) -> bpy.types.Image | None:
    if not path.exists():
        print("WARN missing texture", path)
        return None
    return bpy.data.images.load(str(path), check_existing=True)


def make_pbr_material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float,
    *,
    metalness: float = 0.0,
    coat: float = 0.0,
    coat_rough: float = 0.35,
    diff: Path | None = None,
    nor: Path | None = None,
    rough: Path | None = None,
    color_tint: tuple[float, float, float] | None = None,
) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (300, 0)
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metalness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = coat_rough
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.4

    tex_coord = nodes.new("ShaderNodeTexCoord")
    tex_coord.location = (-800, 0)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-600, 0)
    mapping.inputs["Scale"].default_value = (2.2, 2.2, 2.2)
    links.new(tex_coord.outputs["UV"], mapping.inputs["Vector"])

    color_out = bsdf.inputs["Base Color"]
    if diff and diff.exists():
        img = load_image(diff)
        if img:
            tex = nodes.new("ShaderNodeTexImage")
            tex.location = (-400, 200)
            tex.image = img
            links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
            if color_tint:
                mix = nodes.new("ShaderNodeMixRGB")
                mix.location = (-100, 200)
                mix.blend_type = "MULTIPLY"
                mix.inputs["Fac"].default_value = 1.0
                mix.inputs["Color2"].default_value = (*color_tint, 1.0)
                links.new(tex.outputs["Color"], mix.inputs["Color1"])
                links.new(mix.outputs["Color"], color_out)
            else:
                links.new(tex.outputs["Color"], color_out)

    if nor and nor.exists():
        img = load_image(nor)
        if img:
            img.colorspace_settings.name = "Non-Color"
            tex = nodes.new("ShaderNodeTexImage")
            tex.location = (-400, -50)
            tex.image = img
            links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
            nrm = nodes.new("ShaderNodeNormalMap")
            nrm.location = (-100, -50)
            nrm.inputs["Strength"].default_value = 0.85
            links.new(tex.outputs["Color"], nrm.inputs["Color"])
            links.new(nrm.outputs["Normal"], bsdf.inputs["Normal"])

    if rough and rough.exists():
        img = load_image(rough)
        if img:
            img.colorspace_settings.name = "Non-Color"
            tex = nodes.new("ShaderNodeTexImage")
            tex.location = (-400, -280)
            tex.image = img
            links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
            # Keep husk quite rough
            mult = nodes.new("ShaderNodeMath")
            mult.location = (-100, -280)
            mult.operation = "MULTIPLY"
            mult.inputs[1].default_value = 1.05
            links.new(tex.outputs["Color"], mult.inputs[0])
            links.new(mult.outputs["Value"], bsdf.inputs["Roughness"])

    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m


def husk_mat() -> bpy.types.Material:
    # Geometry-only materials — full PBR maps applied at runtime in Three.js
    # (keeps GLB small; textures live in public/textures/coconut/)
    return make_pbr_material(
        "CoconutHusk",
        (0.28, 0.16, 0.08, 1.0),
        roughness=0.88,
        coat=0.05,
        coat_rough=0.6,
    )


def flesh_mat() -> bpy.types.Material:
    return make_pbr_material(
        "CoconutFlesh",
        (0.92, 0.88, 0.78, 1.0),
        roughness=0.55,
        coat=0.35,
        coat_rough=0.28,
    )


def make_open_shell() -> bpy.types.Object:
    """
    Open coconut bowl: outer husk hemisphere + inner flesh shell.
    Opening faces +Z in Blender (will map for game placement).
    """
    husk = husk_mat()
    flesh = flesh_mat()

    # --- Outer husk (half sphere, slightly flattened) ---
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=SEGMENTS, ring_count=RINGS, radius=SHELL_R, location=(0, 0, 0)
    )
    outer = bpy.context.active_object
    assert outer is not None
    outer.name = "CoconutHusk"
    outer.scale = (1.05, 0.98, 0.92)
    apply(outer)

    # Delete top hemisphere (keep bottom bowl opening upward +Z after rotate)
    bpy.ops.object.mode_set(mode="EDIT")
    bm = bmesh.from_edit_mesh(outer.data)
    bm.verts.ensure_lookup_table()
    # First rotate so pole is Z — UV sphere poles are Z already; delete verts with z > small eps
    to_del = [v for v in bm.verts if v.co.z > 0.004]
    bmesh.ops.delete(bm, geom=to_del, context="VERTS")
    bmesh.update_edit_mesh(outer.data)
    bpy.ops.object.mode_set(mode="OBJECT")

    # Solidify outer thickness
    solid = outer.modifiers.new("Solidify", "SOLIDIFY")
    solid.thickness = 0.0045
    solid.offset = 1.0
    bpy.ops.object.modifier_apply(modifier=solid.name)

    # Fiber-ish displacement (low strength)
    disp = outer.modifiers.new("FiberDisp", "DISPLACE")
    tex = bpy.data.textures.new("FiberNoise", type="CLOUDS")
    tex.noise_scale = 0.35
    tex.noise_depth = 2
    disp.texture = tex
    disp.strength = 0.0018
    bpy.ops.object.modifier_apply(modifier=disp.name)

    # Smooth + subdiv for quality
    sub = outer.modifiers.new("Subsurf", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 2
    bpy.ops.object.modifier_apply(modifier=sub.name)

    outer.data.materials.clear()
    outer.data.materials.append(husk)

    # --- Inner flesh bowl ---
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=SEGMENTS, ring_count=RINGS, radius=SHELL_R * INNER_SCALE, location=(0, 0, 0.001)
    )
    inner = bpy.context.active_object
    assert inner is not None
    inner.name = "CoconutFlesh"
    inner.scale = (1.02, 0.96, 0.9)
    apply(inner)

    bpy.ops.object.mode_set(mode="EDIT")
    bm = bmesh.from_edit_mesh(inner.data)
    to_del = [v for v in bm.verts if v.co.z > 0.003]
    bmesh.ops.delete(bm, geom=to_del, context="VERTS")
    bmesh.update_edit_mesh(inner.data)
    bpy.ops.object.mode_set(mode="OBJECT")

    # Flip normals inward so we see flesh from inside
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.flip_normals()
    bpy.ops.object.mode_set(mode="OBJECT")

    solid_i = inner.modifiers.new("Solidify", "SOLIDIFY")
    solid_i.thickness = 0.0028
    solid_i.offset = -1.0
    bpy.ops.object.modifier_apply(modifier=solid_i.name)

    sub_i = inner.modifiers.new("Subsurf", "SUBSURF")
    sub_i.levels = 1
    bpy.ops.object.modifier_apply(modifier=sub_i.name)

    inner.data.materials.clear()
    inner.data.materials.append(flesh)

    # Rim bead (cut edge)
    bpy.ops.mesh.primitive_torus_add(
        major_radius=SHELL_R * 0.93,
        minor_radius=0.0032,
        major_segments=SEGMENTS,
        minor_segments=12,
        location=(0, 0, 0.002),
    )
    rim = bpy.context.active_object
    assert rim is not None
    rim.name = "CoconutRim"
    rim.scale = (1.02, 0.98, 1.0)
    apply(rim)
    rim.data.materials.clear()
    rim.data.materials.append(husk)

    # Join husk + rim (outer), keep flesh separate for multi-material or join all
    bpy.ops.object.select_all(action="DESELECT")
    outer.select_set(True)
    rim.select_set(True)
    bpy.context.view_layer.objects.active = outer
    bpy.ops.object.join()
    shell_outer = bpy.context.active_object
    assert shell_outer is not None
    shell_outer.name = "CoconutOuter"

    # Parent/join flesh into single export object with multi-materials
    bpy.ops.object.select_all(action="DESELECT")
    shell_outer.select_set(True)
    inner.select_set(True)
    bpy.context.view_layer.objects.active = shell_outer
    bpy.ops.object.join()
    shell = bpy.context.active_object
    assert shell is not None
    shell.name = "CoconutShell"

    # Ground: lowest point at z=0, opening faces +Z
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    # Shift so resting on table
    min_z = min((shell.matrix_world @ Vector(c)).z for c in shell.bound_box)
    shell.location.z -= min_z
    apply(shell)

    # UV
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()

    # Seed rest height (inside bowl, above bottom)
    seed_z = SHELL_DEPTH * 0.28
    seed_radius = SHELL_R * INNER_SCALE * 0.72

    return shell, {
        "seedRestZ": round(seed_z, 5),
        "seedPackRadius": round(seed_radius, 5),
        "shellRadius": round(SHELL_R, 5),
        "shellDepth": round(SHELL_DEPTH, 5),
    }


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        use_selection=True,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
    )


def main() -> None:
    try:
        clear()
        shell, meta = make_open_shell()
        export_glb(shell, OUT / "coconut_shell.glb")

        # Blender Z-up positions for S (near) and N (far), relative to board origin.
        # Board: South y=-0.09, North y=+0.09 in Blender (before export).
        # Place shells beside the board, openings up (+Z).
        # South pits use blender y < 0 → three Z = -y > 0 (near camera).
        stores = {
            "S": {
                "player": "S",
                "label": "B-store",
                "x": 0.52,
                "y": -0.34,
                "z": 0.0,
                "rotZ": -0.35,
                **meta,
            },
            "N": {
                "player": "N",
                "label": "A-store",
                "x": -0.52,
                "y": 0.34,
                "z": 0.0,
                "rotZ": 2.8,
                **meta,
            },
        }

        layout = {
            "unit": "meters",
            "coordinateSystem": "blender_z_up",
            "gltfMapping": "three = (bx, bz, -by)",
            "model": "coconut_shell.glb",
            "materials": ["CoconutHusk", "CoconutFlesh"],
            "textures": {
                "husk": ["husk_diff.jpg", "husk_nor.jpg", "husk_rough.jpg"],
                "flesh": ["flesh_diff.jpg", "flesh_nor.jpg", "flesh_rough.jpg"],
            },
            "stores": stores,
            "notes": "Open coconut score bowls for captured beads (PBR husk + flesh)",
        }
        text = json.dumps(layout, indent=2)
        (OUT / "store_layout.json").write_text(text)
        (LAYOUT_SRC / "store_layout.json").write_text(text)
        print("OK", OUT / "coconut_shell.glb")
        print("layout", stores)
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
