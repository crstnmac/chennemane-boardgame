"""
Chennamane assets — simple, correct scale.

Blender Z-up board:
  size 0.90 × 0.28 × 0.05, origin center, bottom Z=0
  South pits y=-0.07, North y=+0.07
glTF Y-up mapping: (x,y,z)_b → (x, z, -y)_three
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def project_root() -> Path:
    for arg in sys.argv:
        if arg.endswith("generate_chennamane_assets.py"):
            return Path(arg).resolve().parents[2]
    return Path("/Users/cristonmascarenhas/orca/projects/chennamane")


ROOT = project_root()
OUT = ROOT / "public" / "models"
OUT.mkdir(parents=True, exist_ok=True)

L, W, H = 0.90, 0.28, 0.05
PIT_R = 0.040
ROW_Y = 0.070  # |y| of each row
COLS_X = [-0.36, -0.24, -0.12, 0.0, 0.12, 0.24, 0.36]


def clear() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials):
        for b in list(coll):
            if b.users == 0:
                coll.remove(b)


def wood_mat() -> bpy.types.Material:
    m = bpy.data.materials.new("Wood")
    m.use_nodes = True
    n = m.node_tree.nodes
    bsdf = n.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.38, 0.21, 0.10, 1)
    bsdf.inputs["Roughness"].default_value = 0.6
    return m


def seed_mat() -> bpy.types.Material:
    m = bpy.data.materials.new("Seed")
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.78, 0.12, 0.07, 1)
    bsdf.inputs["Roughness"].default_value = 0.35
    return m


def apply(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def make_board() -> tuple[bpy.types.Object, list[dict]]:
    # Box with bottom on Z=0
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, H / 2))
    board = bpy.context.active_object
    board.name = "Board"
    board.scale = (L, W, H)
    apply(board)
    board.data.materials.append(wood_mat())

    # Light bevel
    mod = board.modifiers.new("Bevel", "BEVEL")
    mod.width = 0.004
    mod.segments = 2
    bpy.context.view_layer.objects.active = board
    bpy.ops.object.modifier_apply(modifier="Bevel")

    pits: list[dict] = []
    for base, y in ((0, -ROW_Y), (7, ROW_Y)):
        for col, x in enumerate(COLS_X):
            # Sphere boolean — center near top so bowl forms
            bpy.ops.mesh.primitive_uv_sphere_add(
                radius=PIT_R,
                location=(x, y, H - 0.012),
                segments=24,
                ring_count=12,
            )
            cutter = bpy.context.active_object
            apply(cutter)

            bpy.ops.object.select_all(action="DESELECT")
            board.select_set(True)
            bpy.context.view_layer.objects.active = board
            bmod = board.modifiers.new(f"P{base+col}", "BOOLEAN")
            bmod.operation = "DIFFERENCE"
            bmod.object = cutter
            bmod.solver = "EXACT"
            bpy.ops.object.modifier_apply(modifier=bmod.name)
            bpy.data.objects.remove(cutter, do_unlink=True)

            # Seed rest height ~ pit floor
            seed_z = H - 0.022
            pits.append(
                {
                    "index": base + col,
                    "label": ("B" if base == 0 else "A") + str(col + 1),
                    "x": round(x, 5),
                    "y": round(y, 5),
                    "z": round(seed_z, 5),
                    "radius": round(PIT_R * 0.85, 5),
                }
            )

    # Force origin to world 0, bottom z=0
    apply(board)
    bbox = [board.matrix_world @ Vector(c) for c in board.bound_box]
    min_z = min(v.z for v in bbox)
    cx = (min(v.x for v in bbox) + max(v.x for v in bbox)) / 2
    cy = (min(v.y for v in bbox) + max(v.y for v in bbox)) / 2
    board.location.x -= cx
    board.location.y -= cy
    board.location.z -= min_z
    apply(board)

    for p in pits:
        p["x"] = round(p["x"] - cx, 5)
        p["y"] = round(p["y"] - cy, 5)
        p["z"] = round(p["z"] - min_z, 5)

    bpy.ops.object.shade_smooth()

    # Sanity print bounds
    bbox = [board.matrix_world @ Vector(c) for c in board.bound_box]
    print(
        "BOARD_BOUNDS",
        [round(min(v.x for v in bbox), 4), round(max(v.x for v in bbox), 4)],
        [round(min(v.y for v in bbox), 4), round(max(v.y for v in bbox), 4)],
        [round(min(v.z for v in bbox), 4), round(max(v.z for v in bbox), 4)],
    )
    print("PIT0", pits[0], "PIT7", next(p for p in pits if p["index"] == 7))
    return board, pits


def make_seed() -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.010, segments=20, ring_count=12)
    seed = bpy.context.active_object
    seed.name = "Seed"
    seed.scale = (1.0, 0.9, 0.8)
    apply(seed)
    seed.data.materials.append(seed_mat())
    bpy.ops.object.shade_smooth()
    return seed


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
        export_materials="EXPORT",
        export_normals=True,
    )


def main() -> None:
    clear()
    board, pits = make_board()
    export_glb(board, OUT / "board.glb")
    (OUT / "pit_layout.json").write_text(
        json.dumps(
            {
                "unit": "meters",
                "coordinateSystem": "blender_z_up",
                "gltfMapping": "three = (bx, bz, -by)",
                "boardSize": {"x": L, "y": W, "z": H},
                "pits": sorted(pits, key=lambda p: p["index"]),
            },
            indent=2,
        )
    )
    clear()
    seed = make_seed()
    export_glb(seed, OUT / "seed.glb")
    print("OK", OUT)


if __name__ == "__main__":
    main()
