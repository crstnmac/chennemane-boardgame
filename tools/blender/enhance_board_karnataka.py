"""
Enhance Chennamane board for a premium Karnataka look (Blender MCP / headless).

- Imports public/models/board.glb
- Soft border radius (bevel) on the wood body
- Side ornaments: lotus medallions + temple-style geometric band (bronze)
- Re-applies kitchen_wood PBR + cube UVs
- Exports public/models/board.glb (Y-up)

Run via Blender MCP execute_code or:
  Blender --background --python tools/blender/enhance_board_karnataka.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector


def project_root() -> Path:
    for a in sys.argv:
        if a.endswith("enhance_board_karnataka.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
BOARD_GLB = ROOT / "public" / "models" / "board.glb"
TEX = ROOT / "public" / "textures" / "wood"
OUT_GLB = BOARD_GLB


def clear_all_objects() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.curves,
        bpy.data.images,
        bpy.data.textures,
    ):
        for b in list(coll):
            try:
                coll.remove(b)
            except Exception:
                pass


def apply_obj(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


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


def make_wood_mat() -> bpy.types.Material:
    name = "BoardWood"
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.78
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.04
        bsdf.inputs["Coat Roughness"].default_value = 0.72
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")
    mp.vector_type = "TEXTURE"
    mp.inputs["Scale"].default_value = (1.5, 1.5, 1.5)
    links.new(tc.outputs["UV"], mp.inputs["Vector"])

    def tex(img: bpy.types.Image, y: float):
        n = nodes.new("ShaderNodeTexImage")
        n.image = img
        n.location = (-300, y)
        links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n

    d = load_image(TEX / "wood_diff.jpg", "kitchen_wood_diff", False)
    n = load_image(TEX / "wood_nor.jpg", "kitchen_wood_nor", True)
    r = load_image(TEX / "wood_rough.jpg", "kitchen_wood_rough", True)
    nd, nn, nr = tex(d, 200), tex(n, 0), tex(r, -200)
    links.new(nd.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(nr.outputs["Color"], bsdf.inputs["Roughness"])
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.55
    links.new(nn.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_bronze_mat() -> bpy.types.Material:
    name = "BoardBronze"
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.62, 0.42, 0.18, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.42
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.85
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.12
        bsdf.inputs["Coat Roughness"].default_value = 0.4
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_iron_mat() -> bpy.types.Material:
    name = "BoardIron"
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.35, 0.32, 0.3, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.55
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.9
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def bevel_wood(obj: bpy.types.Object, amount: float = 0.014, segments: int = 4) -> None:
    """Rounded border radius on outer rim edges of the wood body."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    # Bevel modifier is robust on dense heightfield mesh
    mod = obj.modifiers.new(name="BorderRadius", type="BEVEL")
    mod.width = amount
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(40.0)
    mod.affect = "EDGES"
    mod.miter_outer = "MITER_ARC"
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_smooth()
    print("BEVELED", obj.name, "amount", amount, "segments", segments)


def cube_uv(obj: bpy.types.Object, cube_size: float = 0.48) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(
        cube_size=cube_size,
        correct_aspect=True,
        clip_to_bounds=False,
        scale_to_bounds=False,
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def lotus_medallion(
    name: str,
    location: tuple[float, float, float],
    rotation: tuple[float, float, float],
    bronze: bpy.types.Material,
    radius: float = 0.018,
) -> bpy.types.Object:
    """
    Simplified padma (lotus) medallion — Karnataka temple jewelry motif.
    Central boss + 8 radial petal wedges, low relief on side of board.
    """
    bm = bmesh.new()
    # Central dome (half-sphere proxy via scaled icosphere)
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=radius * 0.42)
    for v in bm.verts:
        # Flatten toward board (local -Y will face outward after rotate)
        v.co.z *= 0.55
        if v.co.z < 0:
            v.co.z *= 0.2

    # Petals: elongated teardrop disks around center
    petals = 8
    for i in range(petals):
        a = (i / petals) * math.pi * 2
        # Create small sphere and squash into petal
        ret = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius * 0.28)
        verts = ret["verts"]
        # Local transform: stretch + offset
        for v in verts:
            v.co.x *= 0.55
            v.co.y *= 1.35
            v.co.z *= 0.35
            # Rotate around Z and push out
            x, y = v.co.x, v.co.y
            ca, sa = math.cos(a), math.sin(a)
            v.co.x = x * ca - y * sa + math.sin(a) * radius * 0.55
            v.co.y = x * sa + y * ca + math.cos(a) * radius * 0.55
            v.co.z += radius * 0.08

    # Outer ring
    bmesh.ops.create_circle(bm, cap_ends=False, radius=radius * 0.95, segments=24)
    # Extrude ring slightly in Z for relief line
    ring_verts = [v for v in bm.verts if abs(v.co.length - radius * 0.95) < radius * 0.08]
    # Just use a torus for cleaner ring
    me = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)

    # Add a proper torus ring as separate join
    bpy.ops.mesh.primitive_torus_add(
        major_radius=radius * 0.92,
        minor_radius=radius * 0.06,
        major_segments=28,
        minor_segments=8,
        location=(0, 0, 0),
    )
    ring = bpy.context.active_object
    assert ring is not None
    ring.name = name + "_ring"

    # Join ring into medallion
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    ring.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    obj = bpy.context.active_object
    assert obj is not None
    obj.name = name

    obj.location = location
    obj.rotation_euler = rotation
    apply_obj(obj)
    obj.data.materials.clear()
    obj.data.materials.append(bronze)
    bpy.ops.object.shade_smooth()
    return obj


def geometric_band(
    name: str,
    length: float,
    location: tuple[float, float, float],
    rotation_z: float,
    bronze: bpy.types.Material,
) -> list[bpy.types.Object]:
    """
    Temple-rail band: thin bronze strip with diamond lozenges (gopuram geometry).
    """
    parts: list[bpy.types.Object] = []
    # Main rail
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    rail = bpy.context.active_object
    assert rail is not None
    rail.name = name + "_rail"
    rail.scale = (length * 0.92, 0.006, 0.01)
    rail.rotation_euler[2] = rotation_z
    apply_obj(rail)
    rail.data.materials.clear()
    rail.data.materials.append(bronze)
    parts.append(rail)

    # Diamond lozenges along rail
    n = max(5, int(length / 0.09))
    for i in range(n):
        t = (i + 0.5) / n - 0.5
        # Local offset along length (X before rotation)
        lx = t * length * 0.88
        # World position after rotation around Z
        ca, sa = math.cos(rotation_z), math.sin(rotation_z)
        wx = location[0] + lx * ca
        wy = location[1] + lx * sa
        wz = location[2]
        bpy.ops.mesh.primitive_cube_add(size=1, location=(wx, wy, wz))
        d = bpy.context.active_object
        assert d is not None
        d.name = f"{name}_loz_{i}"
        d.scale = (0.012, 0.005, 0.012)
        d.rotation_euler[2] = rotation_z + math.radians(45)
        apply_obj(d)
        d.data.materials.clear()
        d.data.materials.append(bronze)
        parts.append(d)

    return parts


def side_ornaments(
    wood: bpy.types.Object,
    bronze: bpy.types.Material,
) -> list[bpy.types.Object]:
    """Place Karnataka-inspired ornaments on the four sides of the board."""
    # Bounds of wood mesh
    bb = [wood.matrix_world @ Vector(c) for c in wood.bound_box]
    xs = [v.x for v in bb]
    ys = [v.y for v in bb]
    zs = [v.z for v in bb]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    cx = (min_x + max_x) * 0.5
    cy = (min_y + max_y) * 0.5
    # Mid-height of side wall
    mid_z = min_z + (max_z - min_z) * 0.42
    half_l = (max_x - min_x) * 0.5
    half_w = (max_y - min_y) * 0.5
    # Slightly outside the wood surface
    out = 0.004

    parts: list[bpy.types.Object] = []

    # Long sides (N/S — ±Y) and short sides (E/W — ±X)
    # Blender board: length along X, width along Y
    sides = [
        # name, band_loc, band_rot_z, band_len, medallion centers (x,y,z), medallion rot
        (
            "South",
            (cx, min_y - out, mid_z),
            0.0,
            half_l * 1.55,
            [
                (cx - half_l * 0.55, min_y - out - 0.001, mid_z),
                (cx, min_y - out - 0.001, mid_z),
                (cx + half_l * 0.55, min_y - out - 0.001, mid_z),
            ],
            (math.radians(90), 0.0, 0.0),
        ),
        (
            "North",
            (cx, max_y + out, mid_z),
            0.0,
            half_l * 1.55,
            [
                (cx - half_l * 0.55, max_y + out + 0.001, mid_z),
                (cx, max_y + out + 0.001, mid_z),
                (cx + half_l * 0.55, max_y + out + 0.001, mid_z),
            ],
            (math.radians(-90), 0.0, 0.0),
        ),
        (
            "West",
            (min_x - out, cy, mid_z),
            math.radians(90),
            half_w * 1.4,
            [
                (min_x - out - 0.001, cy - half_w * 0.35, mid_z),
                (min_x - out - 0.001, cy + half_w * 0.35, mid_z),
            ],
            (0.0, math.radians(-90), 0.0),
        ),
        (
            "East",
            (max_x + out, cy, mid_z),
            math.radians(90),
            half_w * 1.4,
            [
                (max_x + out + 0.001, cy - half_w * 0.35, mid_z),
                (max_x + out + 0.001, cy + half_w * 0.35, mid_z),
            ],
            (0.0, math.radians(90), 0.0),
        ),
    ]

    for side_name, bloc, brot, blen, meds, mrot in sides:
        parts.extend(
            geometric_band(f"OrnBand_{side_name}", blen, bloc, brot, bronze)
        )
        for i, mloc in enumerate(meds):
            parts.append(
                lotus_medallion(
                    f"Lotus_{side_name}_{i}",
                    mloc,
                    mrot,
                    bronze,
                    radius=0.016 if side_name in ("South", "North") else 0.014,
                )
            )

    # Upper & lower thin rails (temple cornice / adhishthana lines)
    for label, zf in (("TopRail", 0.78), ("BotRail", 0.18)):
        z = min_z + (max_z - min_z) * zf
        for side, y, rz in (
            ("S", min_y - out * 0.5, 0.0),
            ("N", max_y + out * 0.5, 0.0),
        ):
            bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, y, z))
            r = bpy.context.active_object
            assert r is not None
            r.name = f"{label}_{side}"
            r.scale = ((max_x - min_x) * 0.96, 0.004, 0.005)
            apply_obj(r)
            r.data.materials.clear()
            r.data.materials.append(bronze)
            parts.append(r)

    print("ORNAMENTS", len(parts))
    return parts


def join_meshes(name: str, objs: list[bpy.types.Object]) -> bpy.types.Object | None:
    objs = [o for o in objs if o and o.name in bpy.data.objects]
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    joined = bpy.context.active_object
    assert joined is not None
    joined.name = name
    return joined


def main() -> None:
    if not BOARD_GLB.exists():
        raise FileNotFoundError(BOARD_GLB)
    for f in ("wood_diff.jpg", "wood_nor.jpg", "wood_rough.jpg"):
        if not (TEX / f).exists():
            raise FileNotFoundError(TEX / f)

    clear_all_objects()
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=str(BOARD_GLB))
    imported = [bpy.data.objects[n] for n in set(bpy.data.objects.keys()) - before]
    meshes = [o for o in imported if o.type == "MESH"]
    print("IMPORTED", [m.name for m in meshes])

    wood = None
    metal_parts = []
    for o in meshes:
        nl = o.name.lower()
        if "wood" in nl:
            wood = o
        else:
            metal_parts.append(o)
    if wood is None:
        wood = max(meshes, key=lambda o: len(o.data.vertices))

    print("WOOD", wood.name, "verts", len(wood.data.vertices))

    # Soft border radius
    bevel_wood(wood, amount=0.012, segments=4)

    # Materials + UVs
    wood_mat = make_wood_mat()
    bronze = make_bronze_mat()
    iron = make_iron_mat()  # keep name for multi-mat GLB continuity
    _ = iron
    wood.data.materials.clear()
    wood.data.materials.append(wood_mat)
    cube_uv(wood, cube_size=0.48)

    # Ensure existing metal keeps bronze/iron if present
    for m in metal_parts:
        if not m.data.materials:
            m.data.materials.append(bronze)

    # Karnataka side designs
    orn = side_ornaments(wood, bronze)
    orn_joined = join_meshes("BoardOrnaments", orn)

    # Export all meshes
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.select_set(True)
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
    if size < 50_000:
        raise RuntimeError(f"Export suspiciously small: {size}")
    print(
        "EXPORTED",
        OUT_GLB,
        size,
        "wood_v",
        len(wood.data.vertices),
        "ornaments",
        orn_joined.name if orn_joined else None,
    )


if __name__ == "__main__":
    main()
