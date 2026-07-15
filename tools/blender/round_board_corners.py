"""
Round outer plan-corners of board.glb via boolean ∩ rounded-rectangle prism.
Preserves pits, ornaments, metals. Re-applies kitchen_wood + cube UVs.

  Blender --background --python tools/blender/round_board_corners.py
  # or Blender MCP execute_code runpy
"""
from __future__ import annotations
import math, sys
from pathlib import Path
import bmesh, bpy
from mathutils import Vector

def project_root() -> Path:
    for a in sys.argv:
        if a.endswith("round_board_corners.py"):
            return Path(a).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")

ROOT = project_root()
BOARD = ROOT / "public/models/board.glb"
TEX = ROOT / "public/textures/wood"
OUT = BOARD

def clear_all():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.textures, bpy.data.curves):
        for b in list(coll):
            try: coll.remove(b)
            except Exception: pass

def load_image(path, name, non_color=False):
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

def rounded_rect_mesh(name, w, d, h, r, segs=12):
    bm = bmesh.new()
    hw, hd = w * 0.5, d * 0.5
    r = min(r, hw - 0.001, hd - 0.001)
    pts = []
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
            pts.append((cx0 + math.cos(a) * r, cy0 + math.sin(a) * r, 0.0))
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

def main():
    if not BOARD.exists():
        raise FileNotFoundError(BOARD)
    clear_all()
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=str(BOARD))
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in before or True]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    wood = next((o for o in meshes if "wood" in o.name.lower()), max(meshes, key=lambda o: len(o.data.vertices)))
    bb = [wood.matrix_world @ Vector(c) for c in wood.bound_box]
    xs, ys, zs = [v.x for v in bb], [v.y for v in bb], [v.z for v in bb]
    min_x, max_x, min_y, max_y, min_z, max_z = min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)
    cx, cy, cz = (min_x + max_x) / 2, (min_y + max_y) / 2, (min_z + max_z) / 2
    sx, sy, sz = max_x - min_x, max_y - min_y, max_z - min_z
    corner_r = max(0.028, min(min(sx, sy) * 0.12, 0.055))
    print("WOOD", wood.name, "CORNER_R", corner_r)
    cutter = rounded_rect_mesh("RoundCutter", sx + 0.002, sy + 0.002, sz + 0.08, corner_r, 12)
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
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.00015)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bmod = wood.modifiers.new("SoftEdge", "BEVEL")
    bmod.width = 0.006
    bmod.segments = 3
    bmod.limit_method = "ANGLE"
    bmod.angle_limit = math.radians(35)
    try:
        bpy.ops.object.modifier_apply(modifier=bmod.name)
    except Exception:
        pass
    bpy.ops.object.shade_smooth()
    # wood mat + UV
    mat = bpy.data.materials.get("BoardWood") or bpy.data.materials.new("BoardWood")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.78
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")
    mp.vector_type = "TEXTURE"
    mp.inputs["Scale"].default_value = (1.5, 1.5, 1.5)
    links.new(tc.outputs["UV"], mp.inputs["Vector"])
    def tex(path, name, y, nc):
        n = nodes.new("ShaderNodeTexImage")
        n.image = load_image(path, name, nc) if False else None
        return n
    def load_image(path, name, non_color=False):
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
    def texn(img, y):
        n = nodes.new("ShaderNodeTexImage")
        n.image = img
        n.location = (-300, y)
        links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n
    nd = texn(load_image(TEX / "wood_diff.jpg", "kw_d", False), 200)
    nn = texn(load_image(TEX / "wood_nor.jpg", "kw_n", True), 0)
    nr = texn(load_image(TEX / "wood_rough.jpg", "kw_r", True), -200)
    links.new(nd.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(nr.outputs["Color"], bsdf.inputs["Roughness"])
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.55
    links.new(nn.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    wood.data.materials.clear()
    wood.data.materials.append(mat)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=0.48, correct_aspect=True, clip_to_bounds=False, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), use_selection=True, export_format="GLB",
        export_apply=True, export_yup=True, export_texcoords=True, export_normals=True,
        export_materials="EXPORT", export_image_format="JPEG", export_jpeg_quality=85,
    )
    print("EXPORTED", OUT, OUT.stat().st_size, "verts", len(wood.data.vertices))

if __name__ == "__main__":
    main()
