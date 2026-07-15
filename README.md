# Chennamane

Browser game for the traditional South Indian mancala **Chennamane** (*Ali Guli Mane* / *Bule Perga*).

## Play

```bash
pnpm install
pnpm dev
```

Open the URL Vite prints (usually http://localhost:5173).

```bash
pnpm test      # engine unit tests
pnpm build     # production build + PWA
pnpm preview   # serve dist
```

## Deploy (Dokploy)

Production image is a multi-stage **Vite build → nginx** static site (`Dockerfile`).

**Dokploy**

1. Create an application → **Dockerfile** build
2. Set context to the repo root (Dockerfile at `/Dockerfile`)
3. Expose / publish **port 80** (Traefik / domain routing)
4. Health check path: `/healthz` (optional; image includes `HEALTHCHECK`)

No env vars are required for the static game. Rebuild when `public/models` or `public/textures` change — they are copied at image build time.

**Local smoke test**

```bash
docker build -t chennamane .
docker run --rm -p 8080:80 chennamane
# open http://localhost:8080
```

## Features (MVP)

- Hot-seat 2-player and vs AI (Easy / Medium)
- Canonical *pussa kanawa* sowing + saada capture
- Animated sow / capture, direction chooser, undo/redo, hints
- Settings (seeds 4/5/6, direction mode, animation, sound)
- Rules + quick coach
- Installable offline PWA

## 3D assets (Blender + GLSL shaders)

Assets live in `public/models/` (`board.glb`, `seed.glb`, `pit_layout.json`).

The play board loads the **Blender mesh** and replaces materials with custom **GLSL shaders**
(wood grain FBM + varnish, dark pit bowls, gulaganji seeds).

**With Blender MCP running** (addon on port 9876):

```bash
python3 - <<'PY'
import json, socket
from pathlib import Path
script = Path('tools/blender/generate_premium_board.py').resolve()
code = f"import runpy; runpy.run_path(r'{script}', run_name='__main__')"
s = socket.create_connection(('127.0.0.1', 9876), timeout=180)
s.sendall(json.dumps({"type":"execute_code","params":{"code":code}}).encode())
print(s.recv(1<<20).decode())
PY
```

**Headless:**

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python tools/blender/generate_premium_board.py
```

## Project layout

| Path | Role |
| --- | --- |
| `src/engine` | Pure TypeScript rules (no DOM) |
| `src/ai` | Minimax α-β (sowing-ply) |
| `src/session` | Zustand session + settings |
| `src/ui` | React screens + 3D board |
| `src/ui/three` | R3F scene, pit layout, seeds |
| `public/models` | Blender-exported GLB assets |
| `tools/blender` | Asset generator script |
| `docs/RULES.md` | Human-readable rules |
| `docs/design-chennamane-browser-game.md` | Full design |

## License

Personal / educational project. Traditional game rules are cultural heritage.

Sound effects are CC0 samples by [Kenney](https://kenney.nl) (Impact Sounds + Interface Sounds packs),
played through [Howler.js](https://howlerjs.com) with per-pit stereo panning — see `public/audio/sfx/CREDITS.md`.
