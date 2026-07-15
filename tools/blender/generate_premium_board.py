"""
Chennamane board + seed — Viking-era king board.

Clean heightfield bowls (no boolean scars) plus:
  • raised oak frame / tray rim with rounded plan corners
  • soft outer top-edge fillet (consistent under metal brackets)
  • aged bronze corner wraps + iron rivets (flush, no gaps)
  • kitchen_wood PBR when textures are present
  • center spine between rows

  Blender --background --python tools/blender/generate_premium_board.py
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
        if a.endswith("generate_premium_board.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
OUT = ROOT / "public" / "models"
OUT.mkdir(parents=True, exist_ok=True)
# App imports layout from src (Vite cannot import from public/)
LAYOUT_SRC = ROOT / "src" / "models"
LAYOUT_SRC.mkdir(parents=True, exist_ok=True)
TEX_WOOD = ROOT / "public" / "textures" / "wood"

# Inner play surface size (pits live here)
L, W, H = 1.05, 0.36, 0.055
# Outer frame extends beyond play surface
FRAME_W = 0.028
RIM_H = 0.014
GROOVE_W = 0.008
GROOVE_D = 0.003
# Plan corner radius + soft top outer lip (meters)
CORNER_R = 0.048
TOP_EDGE_R = 0.009

PIT_R = 0.044
PIT_DEPTH = 0.030
ROW_Y = 0.09
COLS = [-0.42, -0.28, -0.14, 0.0, 0.14, 0.28, 0.42]
SEED_Z = H - PIT_DEPTH + 0.011

# Full board extents including frame
L_FULL = L + 2 * FRAME_W
W_FULL = W + 2 * FRAME_W

RES_X = 320
RES_Y = 120


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


def load_image(path: Path, name: str, non_color: bool = False) -> bpy.types.Image | None:
    if not path.exists():
        return None
    if name in bpy.data.images:
        img = bpy.data.images[name]
    else:
        img = bpy.data.images.load(str(path), check_existing=True)
        img.name = name
    try:
        img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    except Exception:
        pass
    return img


def make_principled(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float,
    metalness: float = 0.0,
    coat: float = 0.0,
    coat_rough: float = 0.2,
) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes = m.node_tree.nodes
    links = m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metalness
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.45 if metalness < 0.5 else 0.6
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = coat_rough
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m


def wood_mat() -> bpy.types.Material:
    """BoardWood — kitchen_wood PBR when available (app also rebinds maps)."""
    m = make_principled(
        "BoardWood",
        (0.72, 0.58, 0.42, 1.0),
        roughness=0.78,
        metalness=0.0,
        coat=0.04,
        coat_rough=0.72,
    )
    diff = load_image(TEX_WOOD / "wood_diff.jpg", "kw_diff", False)
    nor = load_image(TEX_WOOD / "wood_nor.jpg", "kw_nor", True)
    rough = load_image(TEX_WOOD / "wood_rough.jpg", "kw_rough", True)
    if not diff:
        return m
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")
    mp.vector_type = "TEXTURE"
    mp.inputs["Scale"].default_value = (1.5, 1.5, 1.5)
    links.new(tc.outputs["UV"], mp.inputs["Vector"])

    def tex(img: bpy.types.Image, y: float):
        n = nodes.new("ShaderNodeTexImage")
        n.image = img
        n.location = (-320, y)
        links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n

    nd = tex(diff, 200)
    links.new(nd.outputs["Color"], bsdf.inputs["Base Color"])
    if rough:
        nr = tex(rough, -200)
        links.new(nr.outputs["Color"], bsdf.inputs["Roughness"])
    if nor:
        nn = tex(nor, 0)
        nmap = nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = 0.55
        links.new(nn.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def bronze_mat() -> bpy.types.Material:
    # Aged bronze / warm gold fittings
    return make_principled(
        "BoardBronze",
        (0.62, 0.42, 0.18, 1.0),
        roughness=0.42,
        metalness=0.85,
        coat=0.12,
        coat_rough=0.4,
    )


def iron_mat() -> bpy.types.Material:
    # Warm iron rivets (avoid cool grey side patches)
    return make_principled(
        "BoardIron",
        (0.42, 0.35, 0.28, 1.0),
        roughness=0.55,
        metalness=0.88,
        coat=0.05,
        coat_rough=0.4,
    )


def seed_mat() -> bpy.types.Material:
    return make_principled(
        "SeedCoral",
        (0.78, 0.16, 0.08, 1.0),
        roughness=0.28,
        metalness=0.05,
        coat=0.45,
        coat_rough=0.12,
    )


def pit_centers() -> list[tuple[int, float, float]]:
    out: list[tuple[int, float, float]] = []
    for base, y in ((0, -ROW_Y), (7, ROW_Y)):
        for col, x in enumerate(COLS):
            out.append((base + col, x, y))
    return out


def edge_in_rounded(x: float, y: float) -> float:
    """
    Signed distance inward from outer boundary of a rounded rectangle.
    Positive = inside footprint, negative = outside.
    """
    half_l, half_w = L_FULL * 0.5, W_FULL * 0.5
    r = min(CORNER_R, half_l - 0.01, half_w - 0.01)
    ax, ay = abs(x), abs(y)
    # Straight-edge inset
    dx = half_l - ax
    dy = half_w - ay
    # Corner region: relative to arc center
    cx = half_l - r
    cy = half_w - r
    if ax > cx and ay > cy:
        return r - math.hypot(ax - cx, ay - cy)
    return min(dx, dy)


def height_at(x: float, y: float, centers: list[tuple[int, float, float]]) -> float:
    """
    Top heightfield:
      - raised outer rim (tray edge) on rounded plan
      - soft outer top lip (fillet profile)
      - shallow groove inside rim
      - low center spine between pit rows
      - clean hemispheric bowls
    """
    ax, ay = abs(x), abs(y)
    edge_in = edge_in_rounded(x, y)

    # Outside rounded footprint
    if edge_in < -1e-6:
        return 0.0

    z = H

    # --- Raised rim (outer frame) ---
    if edge_in < FRAME_W:
        t = 1.0 - max(edge_in, 0.0) / FRAME_W  # 1 at outer edge, 0 at inner frame
        rise = RIM_H * (0.55 + 0.45 * (t * t * (3 - 2 * t)))
        z = H + rise

    # --- Soft outer top lip (quarter-circle drop toward perimeter) ---
    # Keeps the edge under metal brackets consistently rounded (no knife edge).
    if 0.0 <= edge_in < TOP_EDGE_R:
        # a=0 at outer edge (lowest), a=pi/2 fully up on top face
        a = (edge_in / TOP_EDGE_R) * (math.pi * 0.5)
        # drop from full rim height: R*(1-sin) so outer lip is lower
        drop = TOP_EDGE_R * (1.0 - math.sin(a))
        z = z - drop

    # --- Inner groove just inside the rim (carved channel) ---
    groove_start = FRAME_W
    groove_end = FRAME_W + GROOVE_W
    if groove_start <= edge_in < groove_end:
        g = (edge_in - groove_start) / GROOVE_W
        dip = GROOVE_D * math.sin(g * math.pi)
        z = min(z, H - dip)

    # --- Center spine between north/south rows ---
    spine_half = 0.012
    if abs(y) < spine_half and ax < L * 0.48:
        sy = 1.0 - abs(y) / spine_half
        spine = 0.0045 * (sy * sy)
        if edge_in > FRAME_W + GROOVE_W:
            z = max(z, H + spine)

    # --- Pit bowls (only on play field, inside frame) ---
    if ax <= L * 0.5 + 0.002 and ay <= W * 0.5 + 0.002:
        for _, cx, cy in centers:
            dx = x - cx
            dy = y - cy
            d2 = dx * dx + dy * dy
            r2 = PIT_R * PIT_R
            if d2 >= r2:
                continue
            t = math.sqrt(d2) / PIT_R
            depth = PIT_DEPTH * math.cos(t * (math.pi * 0.5))
            z = min(z, H - depth)

    return max(z, 0.002)


def build_wood_body() -> bpy.types.Object:
    """Heightfield on a rounded-rect footprint (outside cells collapsed to boundary)."""
    centers = pit_centers()
    bm = bmesh.new()
    nx, ny = RES_X, RES_Y
    half_l, half_w = L_FULL * 0.5, W_FULL * 0.5

    def clamp_to_footprint(x: float, y: float) -> tuple[float, float]:
        """Project points outside the rounded rect onto its boundary."""
        if edge_in_rounded(x, y) >= -1e-7:
            return x, y
        # Binary search along ray from center to (x,y)
        rmax = math.hypot(x, y)
        if rmax < 1e-9:
            return 0.0, 0.0
        ux, uy = x / rmax, y / rmax
        lo, hi = 0.0, rmax
        for _ in range(24):
            mid = (lo + hi) * 0.5
            if edge_in_rounded(ux * mid, uy * mid) >= 0.0:
                lo = mid
            else:
                hi = mid
        return ux * lo, uy * lo

    top: list[list] = [[None] * (ny + 1) for _ in range(nx + 1)]
    bot: list[list] = [[None] * (ny + 1) for _ in range(nx + 1)]

    for i in range(nx + 1):
        u = i / nx
        x0 = -half_l + u * L_FULL
        for j in range(ny + 1):
            v = j / ny
            y0 = -half_w + v * W_FULL
            x, y = clamp_to_footprint(x0, y0)
            z = height_at(x, y, centers)
            top[i][j] = bm.verts.new((x, y, z))
            bot[i][j] = bm.verts.new((x, y, 0.0))

    for i in range(nx):
        for j in range(ny):
            # Skip degenerate faces where all four corners collapsed outside
            try:
                bm.faces.new((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]))
            except ValueError:
                pass
            try:
                bm.faces.new((bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j]))
            except ValueError:
                pass

    for i in range(nx):
        try:
            bm.faces.new((top[i][0], bot[i][0], bot[i + 1][0], top[i + 1][0]))
        except ValueError:
            pass
        try:
            bm.faces.new((top[i + 1][ny], bot[i + 1][ny], bot[i][ny], top[i][ny]))
        except ValueError:
            pass
    for j in range(ny):
        try:
            bm.faces.new((top[0][j + 1], bot[0][j + 1], bot[0][j], top[0][j]))
        except ValueError:
            pass
        try:
            bm.faces.new((top[nx][j], bot[nx][j], bot[nx][j + 1], top[nx][j + 1]))
        except ValueError:
            pass

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.00015)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("BoardWoodMesh")
    bm.to_mesh(me)
    bm.free()
    me.validate(clean_customdata=True)

    obj = bpy.data.objects.new("BoardWood", me)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(wood_mat())
    return obj


def add_box(
    name: str,
    size: tuple[float, float, float],
    location: tuple[float, float, float],
    mat: bpy.types.Material,
    rotation_z: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    assert obj is not None
    obj.name = name
    obj.scale = size
    obj.rotation_euler[2] = rotation_z
    apply(obj)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def add_cylinder(
    name: str,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    mat: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius,
        depth=depth,
        location=location,
        vertices=20,
    )
    obj = bpy.context.active_object
    assert obj is not None
    obj.name = name
    apply(obj)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def make_corner_bracket(
    name: str,
    corner: str,
    bronze: bpy.types.Material,
    iron: bpy.types.Material,
) -> list[bpy.types.Object]:
    """
    Bronze wrap that follows the rounded plan corner + short straight wings.
    Solid L cross-section digs slightly into wood so there is no edge gap.
    Iron rivets on top flange.
    corner: 'NE' | 'NW' | 'SE' | 'SW' in board XY (Blender).
    """
    half_l = L_FULL * 0.5
    half_w = W_FULL * 0.5
    r = min(CORNER_R, half_l - 0.01, half_w - 0.01)
    sx = 1 if "E" in corner else -1
    sy = 1 if "N" in corner else -1

    # Arc center of the rounded corner
    arc_cx = sx * (half_l - r)
    arc_cy = sy * (half_w - r)
    if sx > 0 and sy > 0:
        a0, a1 = 0.0, math.pi * 0.5
    elif sx < 0 and sy > 0:
        a0, a1 = math.pi * 0.5, math.pi
    elif sx < 0 and sy < 0:
        a0, a1 = math.pi, math.pi * 1.5
    else:
        a0, a1 = math.pi * 1.5, math.pi * 2

    z_top = H + RIM_H
    thick = 0.0040
    top_in = 0.028
    drop = 0.028
    sink = 0.0015
    overhang = 0.0018
    wing = 0.020
    segs = 16

    r_outer = r + overhang
    z_flange_bot = z_top - sink
    z_flange_top = z_top + thick
    z_side_bot = z_top - drop

    samples: list[tuple[float, float]] = []  # (ang, wing_s)
    for i in range(4, 0, -1):
        samples.append((a0, -wing * (i / 4)))
    for i in range(segs + 1):
        samples.append((a0 + (a1 - a0) * (i / segs), 0.0))
    for i in range(1, 5):
        samples.append((a1, wing * (i / 4)))

    # Profile (u inward from outer path, z)
    prof = [
        (top_in, z_flange_top),
        (-overhang * 0.15, z_flange_top),
        (-overhang * 0.15, z_side_bot),
        (0.0025, z_side_bot),
        (0.0025, z_flange_bot),
        (top_in, z_flange_bot),
    ]

    bm = bmesh.new()
    rings: list[list] = []
    for ang, wing_s in samples:
        ox, oy = math.cos(ang), math.sin(ang)
        tx, ty = -math.sin(ang), math.cos(ang)
        bx = arc_cx + ox * r_outer + tx * wing_s
        by = arc_cy + oy * r_outer + ty * wing_s
        ix, iy = -ox, -oy
        ring = []
        for u, z in prof:
            ring.append(bm.verts.new((bx + ix * u, by + iy * u, z)))
        rings.append(ring)

    n_path, n_prof = len(rings), len(prof)
    for i in range(n_path - 1):
        for j in range(n_prof):
            j2 = (j + 1) % n_prof
            try:
                bm.faces.new((rings[i][j], rings[i + 1][j], rings[i + 1][j2], rings[i][j2]))
            except ValueError:
                pass
    try:
        bm.faces.new(list(reversed(rings[0])))
    except ValueError:
        pass
    try:
        bm.faces.new(rings[-1])
    except ValueError:
        pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
    me = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(me)
    bm.free()
    me.validate(clean_customdata=True)

    wrap = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(wrap)
    wrap.data.materials.append(bronze)
    bpy.ops.object.select_all(action="DESELECT")
    wrap.select_set(True)
    bpy.context.view_layer.objects.active = wrap
    # Soft outer metal edges
    mod = wrap.modifiers.new("Soft", "BEVEL")
    mod.width = 0.0012
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(35)
    try:
        mod.use_clamp_overlap = True
    except Exception:
        pass
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:
        if "Soft" in wrap.modifiers:
            wrap.modifiers.remove(wrap.modifiers["Soft"])
    bpy.ops.object.shade_smooth()

    parts: list[bpy.types.Object] = [wrap]
    # Iron rivets on top flange (mid-arc and near ends)
    for t, tag in ((0.22, "a"), (0.5, "b"), (0.78, "c")):
        a = a0 + (a1 - a0) * t
        rx = arc_cx + math.cos(a) * (r - top_in * 0.4)
        ry = arc_cy + math.sin(a) * (r - top_in * 0.4)
        parts.append(
            add_cylinder(
                f"{name}_rivet_{tag}",
                0.0035,
                0.0045,
                (rx, ry, z_flange_top + 0.0015),
                iron,
            )
        )
    return parts


def make_edge_studs(bronze: bpy.types.Material) -> list[bpy.types.Object]:
    """Bronze studs along long edges — king-table hardware."""
    parts: list[bpy.types.Object] = []
    half_w = W_FULL * 0.5
    z = H + RIM_H * 0.55
    xs = [-0.32, -0.16, 0.0, 0.16, 0.32]
    for i, x in enumerate(xs):
        for sign, side in ((1, "N"), (-1, "S")):
            parts.append(
                add_cylinder(
                    f"Stud_{side}_{i}",
                    0.0055,
                    0.006,
                    (x, sign * (half_w - FRAME_W * 0.45), z + 0.003),
                    bronze,
                )
            )
    return parts


def join_objects(name: str, objs: list[bpy.types.Object]) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    joined = bpy.context.active_object
    assert joined is not None
    joined.name = name
    return joined


def center_ground(objs: list[bpy.types.Object]) -> tuple[float, float, float]:
    """Shift all so board sits on z=0 centered in XY. Returns (cx, cy, min_z) applied."""
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mins.x = min(mins.x, w.x)
            mins.y = min(mins.y, w.y)
            mins.z = min(mins.z, w.z)
            maxs.x = max(maxs.x, w.x)
            maxs.y = max(maxs.y, w.y)
            maxs.z = max(maxs.z, w.z)
    cx = 0.5 * (mins.x + maxs.x)
    cy = 0.5 * (mins.y + maxs.y)
    min_z = mins.z
    for o in objs:
        o.location.x -= cx
        o.location.y -= cy
        o.location.z -= min_z
        apply(o)
    return cx, cy, min_z


def export_glb_multi(objs: list[bpy.types.Object], path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
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


def soften_outer_edges(wood: bpy.types.Object) -> None:
    """Light angle bevel — clamped so pits and topology stay clean."""
    bpy.ops.object.select_all(action="DESELECT")
    wood.select_set(True)
    bpy.context.view_layer.objects.active = wood
    mod = wood.modifiers.new("SoftEdges", "BEVEL")
    mod.width = 0.0035
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(42)
    mod.affect = "EDGES"
    mod.miter_outer = "MITER_ARC"
    try:
        mod.use_clamp_overlap = True
    except Exception:
        pass
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:
        if "SoftEdges" in wood.modifiers:
            wood.modifiers.remove(wood.modifiers["SoftEdges"])
    # Heal
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.00015)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def make_board() -> tuple[list[bpy.types.Object], list[dict]]:
    wood = build_wood_body()
    bpy.context.view_layer.objects.active = wood
    wood.select_set(True)
    soften_outer_edges(wood)
    bpy.ops.object.shade_smooth()

    bronze = bronze_mat()
    iron = iron_mat()

    metal_parts: list[bpy.types.Object] = []
    for corner in ("NE", "NW", "SE", "SW"):
        metal_parts.extend(make_corner_bracket(f"Corner_{corner}", corner, bronze, iron))
    metal_parts.extend(make_edge_studs(bronze))

    # Join metal into fewer draw calls (still multi-material)
    metal = join_objects("BoardMetal", metal_parts)

    all_objs = [wood, metal]
    cx, cy, min_z = center_ground(all_objs)

    pits = []
    for idx, x, y in pit_centers():
        pits.append(
            {
                "index": idx,
                "label": ("B" if idx < 7 else "A") + str((idx % 7) + 1),
                "x": round(x - cx, 5),
                "y": round(y - cy, 5),
                "z": round(SEED_Z - min_z, 5),
                "radius": float(PIT_R * 0.9),
            }
        )

    # Normals + UVs on wood
    bpy.ops.object.select_all(action="DESELECT")
    wood.select_set(True)
    bpy.context.view_layer.objects.active = wood
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.uv.cube_project(cube_size=0.48, correct_aspect=True, clip_to_bounds=False, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()

    metal.select_set(True)
    bpy.ops.object.shade_smooth()

    bm = bmesh.new()
    bm.from_mesh(wood.data)
    boundary = sum(1 for e in bm.edges if e.is_boundary)
    nonman = sum(1 for e in bm.edges if not e.is_manifold)
    print(
        "BOARD premium",
        "wood_v",
        len(bm.verts),
        "boundary",
        boundary,
        "nonman",
        nonman,
        "corner_r",
        CORNER_R,
        "top_edge_r",
        TOP_EDGE_R,
        "metal_v",
        len(metal.data.vertices),
    )
    bm.free()
    return all_objs, pits


def make_seed() -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.011, segments=24, ring_count=16)
    seed = bpy.context.active_object
    assert seed is not None
    seed.name = "Seed"
    seed.scale = (1.0, 0.9, 0.8)
    apply(seed)
    seed.data.materials.clear()
    seed.data.materials.append(seed_mat())
    bpy.ops.object.shade_smooth()
    return seed


def main() -> None:
    try:
        clear()
        objs, pits = make_board()
        export_glb_multi(objs, OUT / "board.glb")
        layout_json = json.dumps(
            {
                "unit": "meters",
                "coordinateSystem": "blender_z_up",
                "gltfMapping": "three = (bx, bz, -by)",
                "boardSize": {"x": L_FULL, "y": W_FULL, "z": H + RIM_H},
                "playSurface": {"x": L, "y": W, "z": H},
                "pits": sorted(pits, key=lambda p: p["index"]),
                "materials": ["BoardWood", "BoardBronze", "BoardIron"],
                "notes": "Premium board: rounded corners, soft top rim, bronze wraps, spine (hq7)",
            },
            indent=2,
        )
        (OUT / "pit_layout.json").write_text(layout_json)
        (LAYOUT_SRC / "pit_layout.json").write_text(layout_json)
        # Keep existing leather seed.glb — do not overwrite with plain coral sphere
        print("OK board", OUT / "board.glb", (OUT / "board.glb").stat().st_size)
        for f in sorted(OUT.iterdir()):
            if f.suffix in (".glb", ".json"):
                print(f"  {f.name} {f.stat().st_size}")
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
