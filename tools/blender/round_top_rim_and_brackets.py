"""
Rebuild board with closed, filleted top rim + flush metal corner wraps.

Fixes:
  - open/gap edges on the wood rim after bad bmesh bevels
  - floating metal leaving a visible gap over the board edge

  Blender --background --python tools/blender/round_top_rim_and_brackets.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


def project_root() -> Path:
    for a in sys.argv:
        if a.endswith("round_top_rim_and_brackets.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
DIST = ROOT / "dist/models/board.glb"
PUBLIC = ROOT / "public/models/board.glb"
TEX = ROOT / "public/textures/wood"
OUT = PUBLIC

CORNER_R = 0.050
TOP_EDGE_R = 0.010
TOP_EDGE_SEGS = 3
# Metal: solid L that intersects wood — no floating air gap on the edge
METAL_THICK = 0.0042
METAL_TOP_IN = 0.030  # flange onto top face
METAL_DROP = 0.026
METAL_SINK = 0.0018  # dig into wood top so flange seals
METAL_OVERHANG = 0.0022  # past outer wood plan
METAL_SIDE_IN = 0.0025  # dig into side face
METAL_ARC_SEGS = 18
RIVET_R = 0.0030
METAL_WING = 0.022  # extend onto straight edges


def clear_all() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.textures,
        bpy.data.curves,
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
    else:
        img = bpy.data.images.load(str(path), check_existing=True)
        img.name = name
    try:
        img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    except Exception:
        pass
    return img


def make_wood_mat() -> bpy.types.Material:
    mat = bpy.data.materials.get("BoardWood") or bpy.data.materials.new("BoardWood")
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

    nd = tex(load_image(TEX / "wood_diff.jpg", "kw_d", False), 200)
    nn = tex(load_image(TEX / "wood_nor.jpg", "kw_n", True), 0)
    nr = tex(load_image(TEX / "wood_rough.jpg", "kw_r", True), -200)
    links.new(nd.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(nr.outputs["Color"], bsdf.inputs["Roughness"])
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.55
    links.new(nn.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_bronze_mat() -> bpy.types.Material:
    mat = bpy.data.materials.get("BoardBronze") or bpy.data.materials.new("BoardBronze")
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
    mat = bpy.data.materials.get("BoardIron") or bpy.data.materials.new("BoardIron")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.42, 0.35, 0.28, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.55
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.88
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def world_bbox(obj: bpy.types.Object) -> tuple[float, float, float, float, float, float]:
    bb = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    xs, ys, zs = [v.x for v in bb], [v.y for v in bb], [v.z for v in bb]
    return min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)


def count_boundary(obj: bpy.types.Object) -> int:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    n = sum(1 for e in bm.edges if e.is_boundary)
    bm.free()
    return n


def heal_mesh(obj: bpy.types.Object) -> None:
    """Merge, fill holes, consistent normals — closes rim gaps."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0002)
    bpy.ops.mesh.dissolve_degenerate(threshold=0.0001)
    try:
        bpy.ops.mesh.fill_holes(sides=0)
    except Exception:
        pass
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Delete loose
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.mesh.select_loose()
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    print("HEAL boundary", count_boundary(obj), "v", len(obj.data.vertices))


def rounded_rect_prism(name: str, w: float, d: float, h: float, r: float, segs: int = 14) -> bpy.types.Object:
    bm = bmesh.new()
    hw, hd = w * 0.5, d * 0.5
    r = min(r, hw - 0.001, hd - 0.001)
    pts: list[tuple[float, float]] = []
    corners = [
        (hw - r, hd - r, 0.0, math.pi * 0.5),
        (-hw + r, hd - r, math.pi * 0.5, math.pi),
        (-hw + r, -hd + r, math.pi, math.pi * 1.5),
        (hw - r, -hd + r, math.pi * 1.5, math.pi * 2),
    ]
    for cx0, cy0, a0, a1 in corners:
        for i in range(segs + 1):
            t = i / segs
            a = a0 + (a1 - a0) * t
            pts.append((cx0 + math.cos(a) * r, cy0 + math.sin(a) * r))
    cleaned = [pts[0]]
    for p in pts[1:]:
        if (p[0] - cleaned[-1][0]) ** 2 + (p[1] - cleaned[-1][1]) ** 2 > 1e-12:
            cleaned.append(p)
    if (cleaned[0][0] - cleaned[-1][0]) ** 2 + (cleaned[0][1] - cleaned[-1][1]) ** 2 < 1e-10:
        cleaned.pop()
    bot = [bm.verts.new((p[0], p[1], -h * 0.5)) for p in cleaned]
    top = [bm.verts.new((p[0], p[1], h * 0.5)) for p in cleaned]
    n = len(cleaned)
    bm.faces.new(bot)
    bm.faces.new(list(reversed(top)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return obj


def round_plan_corners(wood: bpy.types.Object, corner_r: float) -> float:
    min_x, max_x, min_y, max_y, min_z, max_z = world_bbox(wood)
    cx, cy, cz = (min_x + max_x) / 2, (min_y + max_y) / 2, (min_z + max_z) / 2
    sx, sy, sz = max_x - min_x, max_y - min_y, max_z - min_z
    r = max(0.028, min(corner_r, min(sx, sy) * 0.12, 0.055))
    print("CORNER_R", r, "size", round(sx, 4), round(sy, 4), round(sz, 4))
    cutter = rounded_rect_prism("RoundCutter", sx + 0.002, sy + 0.002, sz + 0.08, r, 14)
    cutter.location = (cx, cy, cz)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    wood.select_set(True)
    bpy.context.view_layer.objects.active = wood
    mod = wood.modifiers.new("RoundCorners", "BOOLEAN")
    mod.operation = "INTERSECT"
    mod.solver = "EXACT"
    mod.object = cutter
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:
        if "RoundCorners" in wood.modifiers:
            wood.modifiers.remove(wood.modifiers["RoundCorners"])
        mod = wood.modifiers.new("RoundCorners", "BOOLEAN")
        mod.operation = "INTERSECT"
        mod.solver = "FAST"
        mod.object = cutter
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    heal_mesh(wood)
    return r


def fillet_top_rim_safe(wood: bpy.types.Object, width: float, segments: int) -> None:
    """
    Closed-mesh-safe fillet via angle-limited Bevel modifier (no open rim gaps).
    """
    bpy.ops.object.select_all(action="DESELECT")
    wood.select_set(True)
    bpy.context.view_layer.objects.active = wood
    before_b = count_boundary(wood)
    before_v = len(wood.data.vertices)

    mod = wood.modifiers.new("TopRim", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(38)
    mod.affect = "EDGES"
    mod.miter_outer = "MITER_ARC"
    mod.harden_normals = False
    # clamp prevents explosion / open edges
    try:
        mod.use_clamp_overlap = True
    except Exception:
        pass
    bpy.ops.object.modifier_apply(modifier=mod.name)

    heal_mesh(wood)
    after_b = count_boundary(wood)
    after_v = len(wood.data.vertices)
    print(
        "FILLET_SAFE",
        "v",
        before_v,
        "->",
        after_v,
        "boundary",
        before_b,
        "->",
        after_b,
        "width",
        width,
    )
    bpy.ops.object.shade_smooth()


def corner_angles(sx: int, sy: int) -> tuple[float, float]:
    if sx > 0 and sy > 0:
        return 0.0, math.pi * 0.5
    if sx < 0 and sy > 0:
        return math.pi * 0.5, math.pi
    if sx < 0 and sy < 0:
        return math.pi, math.pi * 1.5
    return math.pi * 1.5, math.pi * 2


def corner_wrap_flush(
    name: str,
    board_cx: float,
    board_cy: float,
    z_top: float,
    sx: int,
    sy: int,
    corner_r: float,
    bronze: bpy.types.Material,
) -> bpy.types.Object:
    """
    Solid L-wrap that intersects the wood (no air gap on the edge):
      top flange digs into the wood top, side plate digs into the outer face,
      outer corner is a continuous rounded strip following the plan corner.
    """
    a0, a1 = corner_angles(sx, sy)
    arc_cx = board_cx - sx * corner_r
    arc_cy = board_cy - sy * corner_r

    # Radial extents (from arc center)
    r_outer = corner_r + METAL_OVERHANG
    r_side_inner = corner_r - METAL_SIDE_IN  # into the side face
    r_top_inner = corner_r - METAL_TOP_IN  # flange end on top face

    z_flange_bot = z_top - METAL_SINK
    z_flange_top = z_top + METAL_THICK
    z_side_bot = z_top - METAL_DROP

    # Path samples: arc + short straight wings
    path: list[tuple[float, float]] = []  # angle only for arc; wings use fixed ang + offset later

    samples: list[tuple[float, float, float]] = []  # x_dir uses ang; store (ang, wing_s)
    # wing_s: signed distance along tangent from arc end (0 on arc)

    # start wing (negative wing along -d(ang)/da tangent)
    for i in range(4, 0, -1):
        t = i / 4
        samples.append((a0, -METAL_WING * t))
    for i in range(METAL_ARC_SEGS + 1):
        t = i / METAL_ARC_SEGS
        samples.append((a0 + (a1 - a0) * t, 0.0))
    for i in range(1, 5):
        t = i / 4
        samples.append((a1, METAL_WING * t))

    def sample_frame(ang: float, wing_s: float) -> tuple[float, float, float, float]:
        """Return origin on outer wood corner path + outward (ox,oy)."""
        # Base on arc
        bx = arc_cx + math.cos(ang) * r_outer
        by = arc_cy + math.sin(ang) * r_outer
        ox, oy = math.cos(ang), math.sin(ang)
        # Tangent for +ang
        tx, ty = -math.sin(ang), math.cos(ang)
        # Wings: move along ±tangent at fixed ang (start wing uses negative)
        if wing_s != 0.0:
            bx += tx * wing_s
            by += ty * wing_s
        return bx, by, ox, oy

    # Cross-section: closed octagon-ish L solid in the radial–vertical plane
    # Local coords: u = inward ( - outward ), v = up
    # Outer corner of wood ~ u=0 at r_outer, z=z_top
    def profile_local() -> list[tuple[float, float]]:
        # (u, z) with u>0 inward toward board center from outer path
        u_out = 0.0
        u_side = (r_outer - r_side_inner)  # positive inward
        u_top = (r_outer - r_top_inner)
        return [
            (u_top, z_flange_top),  # inner top of flange
            (u_out - METAL_OVERHANG * 0.2, z_flange_top),  # outer top
            (u_out - METAL_OVERHANG * 0.2, z_side_bot),  # outer bottom
            (u_side, z_side_bot),  # inner bottom of side plate
            (u_side, z_flange_bot),  # up under the edge (seals fillet)
            (u_top, z_flange_bot),  # under flange (inside wood)
        ]

    prof = profile_local()
    bm = bmesh.new()
    rings: list[list] = []
    for ang, wing_s in samples:
        bx, by, ox, oy = sample_frame(ang, wing_s)
        ix, iy = -ox, -oy  # inward
        ring = []
        for u, z in prof:
            # u measured inward from outer path point (bx,by) which is at r_outer
            x = bx + ix * u
            y = by + iy * u
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)

    n_path = len(rings)
    n_prof = len(prof)
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
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.00012)
    me = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(me)
    bm.free()
    me.validate(clean_customdata=True)

    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(bronze)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new("MetalSoft", "BEVEL")
    mod.width = 0.0014
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
        if "MetalSoft" in obj.modifiers:
            obj.modifiers.remove(obj.modifiers["MetalSoft"])
    bpy.ops.object.shade_smooth()
    return obj


def make_rivet(loc: tuple[float, float, float], iron: bpy.types.Material) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=RIVET_R, location=loc, segments=10, ring_count=6)
    o = bpy.context.active_object
    assert o is not None
    o.scale = (1.0, 1.0, 0.5)
    apply_obj(o)
    o.data.materials.clear()
    o.data.materials.append(iron)
    return o


def build_corner_metals(
    wood: bpy.types.Object,
    corner_r: float,
    bronze: bpy.types.Material,
    iron: bpy.types.Material,
) -> bpy.types.Object:
    min_x, max_x, min_y, max_y, min_z, max_z = world_bbox(wood)
    z_top = max_z
    parts: list[bpy.types.Object] = []
    corners = [
        (max_x, max_y, 1, 1),
        (min_x, max_y, -1, 1),
        (min_x, min_y, -1, -1),
        (max_x, min_y, 1, -1),
    ]
    for i, (cx, cy, sx, sy) in enumerate(corners):
        parts.append(corner_wrap_flush(f"Wrap_{i}", cx, cy, z_top, sx, sy, corner_r, bronze))
        a0, a1 = corner_angles(sx, sy)
        arc_cx = cx - sx * corner_r
        arc_cy = cy - sy * corner_r
        for t in (0.2, 0.5, 0.8):
            a = a0 + (a1 - a0) * t
            # top rivet on flange
            rx = arc_cx + math.cos(a) * (corner_r - METAL_TOP_IN * 0.45)
            ry = arc_cy + math.sin(a) * (corner_r - METAL_TOP_IN * 0.45)
            parts.append(make_rivet((rx, ry, z_top + METAL_THICK * 0.9), iron))
            # side rivet
            parts.append(
                make_rivet(
                    (
                        arc_cx + math.cos(a) * (corner_r + METAL_OVERHANG + METAL_THICK * 0.5),
                        arc_cy + math.sin(a) * (corner_r + METAL_OVERHANG + METAL_THICK * 0.5),
                        z_top - METAL_DROP * 0.4,
                    ),
                    iron,
                )
            )

    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    metal = bpy.context.active_object
    assert metal is not None
    metal.name = "BoardMetal"
    print("METAL_BUILT", len(metal.data.vertices))
    return metal


def cube_uv(obj: bpy.types.Object, cube_size: float = 0.48) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=cube_size, correct_aspect=True, clip_to_bounds=False, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def main() -> None:
    src = DIST if DIST.exists() else PUBLIC
    if not src.exists():
        raise FileNotFoundError(src)
    for f in ("wood_diff.jpg", "wood_nor.jpg", "wood_rough.jpg"):
        if not (TEX / f).exists():
            raise FileNotFoundError(TEX / f)

    print("SOURCE", src)
    clear_all()
    bpy.ops.import_scene.gltf(filepath=str(src))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print("IMPORTED", [(m.name, len(m.data.vertices)) for m in meshes])

    wood = next((o for o in meshes if "wood" in o.name.lower()), max(meshes, key=lambda o: len(o.data.vertices)))
    for o in list(meshes):
        if o != wood:
            bpy.data.objects.remove(o, do_unlink=True)

    heal_mesh(wood)
    corner_r = round_plan_corners(wood, CORNER_R)
    fillet_top_rim_safe(wood, TOP_EDGE_R, TOP_EDGE_SEGS)

    wood_mat = make_wood_mat()
    bronze = make_bronze_mat()
    iron = make_iron_mat()
    wood.data.materials.clear()
    wood.data.materials.append(wood_mat)
    cube_uv(wood, 0.48)

    metal = build_corner_metals(wood, corner_r, bronze, iron)

    bpy.ops.object.select_all(action="DESELECT")
    wood.select_set(True)
    bpy.context.view_layer.objects.active = wood
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()

    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT),
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
    size = OUT.stat().st_size
    print(
        "EXPORTED",
        OUT,
        size,
        "WOOD_V",
        len(wood.data.vertices),
        "METAL_V",
        len(metal.data.vertices),
        "BOUNDARY",
        count_boundary(wood),
        "CORNER_R",
        corner_r,
    )
    if size < 50_000:
        raise RuntimeError(f"export too small: {size}")


if __name__ == "__main__":
    main()
