#!/usr/bin/env bash
# Generate low-bandwidth mobile variants of the 3D assets loaded at runtime.
#
#   models:   public/models/<name>.glb        → public/models/<name>.mobile.glb
#             (weld + simplify + KHR_mesh_quantization — decoder-free,
#              loads natively in three.js; material names are preserved,
#              which studioMaterials.ts relies on)
#   textures: public/textures/<path>.jpg      → public/textures-mobile/<path>.jpg
#             (512px, JPEG q65 — plenty at the ≤1.25 dpr mobile canvas cap)
#
# Outputs are committed. Re-run after re-exporting a GLB from Blender or
# swapping a Poly Haven texture set. Requires macOS (sips) + pnpm.
set -euo pipefail
cd "$(dirname "$0")/.."

GLTF="pnpm dlx @gltf-transform/cli"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

simplify_model() {
  local name="$1" ratio="$2" quantize="$3"
  # Embedded GLB textures are never used — toStudioMaterial() replaces every
  # material with external Poly Haven maps — so shrink them to placeholders.
  $GLTF resize "public/models/$name.glb" "$TMP/$name.0.glb" --width 16 --height 16
  $GLTF weld "$TMP/$name.0.glb" "$TMP/$name.a.glb"
  $GLTF simplify "$TMP/$name.a.glb" "$TMP/$name.b.glb" --ratio "$ratio" --error 0.001
  if [ "$quantize" = quantize ]; then
    $GLTF quantize "$TMP/$name.b.glb" "public/models/$name.mobile.glb"
  else
    cp "$TMP/$name.b.glb" "public/models/$name.mobile.glb"
  fi
  ls -la "public/models/$name.glb" "public/models/$name.mobile.glb" | awk '{print $5, $9}'
}

# Board fills the screen — keep more detail than the thumb-sized seeds/shells.
# NO quantize for seed: extractSeedGeometry() clones raw geometry without node
# transforms, so KHR_mesh_quantization's dequantize node scale would be lost
# (seeds render as a giant blob). Its geometry is ~18 KB — not worth it anyway.
simplify_model board 0.4 quantize
simplify_model seed 0.3 no
simplify_model coconut_shell 0.3 quantize

# Texture files referenced at runtime (boardMaterialMaps.ts + HomeVeranda.tsx)
TEXTURES=(
  wood/wood_diff.jpg wood/wood_nor.jpg wood/wood_rough.jpg
  bronze/bronze_diff.jpg bronze/bronze_nor_gl.jpg bronze/bronze_rough.jpg
  iron/iron_diff.jpg iron/iron_nor_gl.jpg iron/iron_rough.jpg iron/iron_metal.jpg
  seed/seed_diff.jpg seed/seed_nor_gl.jpg seed/seed_rough.jpg
  coconut/husk_diff.jpg coconut/husk_nor.jpg coconut/husk_rough.jpg
  coconut/flesh_diff.jpg coconut/flesh_nor.jpg coconut/flesh_rough.jpg
  home/painted_plaster_wall/painted_plaster_wall_diff_1k.jpg
  home/painted_plaster_wall/painted_plaster_wall_nor_gl_1k.jpg
  home/painted_plaster_wall/painted_plaster_wall_rough_1k.jpg
  home/yellow_plaster/yellow_plaster_diff_1k.jpg
  home/yellow_plaster/yellow_plaster_nor_gl_1k.jpg
  home/yellow_plaster/yellow_plaster_rough_1k.jpg
  home/terracotta_floor_tiles/terracotta_floor_tiles_diff_1k.jpg
  home/terracotta_floor_tiles/terracotta_floor_tiles_nor_gl_1k.jpg
  home/terracotta_floor_tiles/terracotta_floor_tiles_rough_1k.jpg
  home/rough_linen/rough_linen_diff_1k.jpg
  home/rough_linen/rough_linen_nor_gl_1k.jpg
  home/rough_linen/rough_linen_rough_1k.jpg
  home/rough_pine_door/rough_pine_door_diff_1k.jpg
  home/rough_pine_door/rough_pine_door_nor_gl_1k.jpg
  home/rough_pine_door/rough_pine_door_rough_1k.jpg
  home/wooden_panels/wooden_panels_diff_1k.jpg
  home/wooden_panels/wooden_panels_nor_gl_1k.jpg
  home/wooden_panels/wooden_panels_rough_1k.jpg
  home/ceiling_interior/ceiling_interior_diff_1k.jpg
  home/ceiling_interior/ceiling_interior_nor_gl_1k.jpg
  home/ceiling_interior/ceiling_interior_rough_1k.jpg
)

for rel in "${TEXTURES[@]}"; do
  src="public/textures/$rel"
  dst="public/textures-mobile/$rel"
  mkdir -p "$(dirname "$dst")"
  sips -Z 512 -s format jpeg -s formatOptions 65 "$src" --out "$dst" > /dev/null
done

# IBL environment — same filename under /hdr-mobile/, half resolution
node scripts/downsample-hdr.mjs \
  public/hdr/wooden_lounge_1k.hdr public/hdr-mobile/wooden_lounge_1k.hdr 2

echo
echo "originals:      $(du -sh public/textures | cut -f1) public/textures"
echo "mobile variants: $(du -sh public/textures-mobile | cut -f1) public/textures-mobile"
