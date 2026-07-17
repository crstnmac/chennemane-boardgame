# Chennamane Pear — full Pear product

Desktop **Ali Guli Mane** multiplayer built as a **Holepunch Pear product**:

| Layer | Implementation |
| --- | --- |
| UI shell | Electron (sandbox + preload `bridge`) |
| App core | **Bare worker** via `pear-runtime` |
| Discovery / sockets | **Hyperswarm** (Noise-encrypted) |
| Storage | **Corestore** (app data + match logs) |
| OTA updates | **pear-runtime** updater + P2P seed pipeline |
| Packaging | Electron Forge (dmg / zip / msix / AppImage) |
| Deploy | `pear touch` → stage → provision → multisig |

Architecture matches [hello-pear-electron](https://github.com/holepunchto/hello-pear-electron) and [docs.pears.com](https://docs.pears.com/).

```
renderer ──bridge──► electron/main ──FramedStream──► Bare workers/main.js
                                                         │
                         ┌───────────────────────────────┼────────────────────────┐
                         ▼                               ▼                        ▼
                   PearRuntime OTA                 P2P session              Corestore
                   (updater events)            (Hyperswarm + engine)      (match Hypercores)
```

## Quick start (development)

Uses the **same React game** as the browser app (3D board, animations, audio).
P2P is only the peer protocol (Hyperswarm Bare worker).

```bash
cd pear-desktop
npm install
npm test
npm run dev               # Vite React (parent) + Electron + P2P worker
```

`npm run dev` starts:

1. Parent monorepo Vite at `http://127.0.0.1:5173` (full React UI)
2. Electron shell with preload bridge + Bare worker for multiplayer

On the home screen (desktop only):

1. **P2P · Create room** → share the 6-character code  
2. Second instance: **Join (North)** with that code  
3. Play the same React game over the peer protocol  

Second instance (isolated storage):

```bash
# terminal A
npm run dev

# terminal B (Vite already up)
PEAR_DEV_SERVER_URL=http://127.0.0.1:5173 npx electron . --no-updates --storage /tmp/chennamane-b
```

## Architecture details

### Bare worker (`workers/main.js`)

Runs inside embedded Bare (not Node) via `PearRuntime.run`:

1. Boots `PearRuntime` with storage + upgrade link  
2. Emits `updating` / `updated` for OTA UI  
3. Hosts the game session (`workers/session.js`)  
4. Appends host state transitions to a **Hypercore match log** (`match:<ROOM>`)

### Host-authoritative multiplayer

| Role | Side | Responsibility |
| --- | --- | --- |
| Host | South | Owns rules; `applyMove` / pass / resign; broadcasts `STATE` |
| Guest | North | Sends intents only; applies host snapshots |

Room codes map to Hyperswarm topics:

```text
SHA256 / blake2b-hash("chennamane-pear-v1:room:" + CODE) → 32-byte topic
```

### Engine

Parent monorepo rules are bundled for Bare:

```bash
npm run build:engine   # ../src/engine → workers/lib/engine.cjs
```

Hooked as `prestart` / `pretest`.

## Pear deployment (production)

Requires the Pear CLI: `npx pear`

### 0. Touch & seed

```bash
pear touch
# → pear://……
pear seed pear://……
```

### 1. Set upgrade link

```bash
npm pkg set upgrade=pear://……
```

### 2–4. Version, make, build deploy directory

```bash
npm version patch
npm run make
# On each OS/arch, then assemble:
pear build --package=package.json \
  --darwin-arm64-app "out/Chennamane Pear-darwin-arm64/Chennamane Pear.app" \
  --target ../chennamane-pear-deploy
```

Never put the deploy directory *inside* the app folder.

### 5. Stage

```bash
pear stage --dry-run pear://…… ../chennamane-pear-deploy
pear stage pear://…… ../chennamane-pear-deploy
```

### 6–7. Provision & multisig

Follow [hello-pear-electron deployments](https://github.com/holepunchto/hello-pear-electron#deployments):

- `pear provision …` for prerelease  
- `pear.json` multisig keys + quorum  
- `pear multisig request | sign | verify | commit`

See `pear.json` for the multisig scaffold (`namespace`: `chennamane/pear-desktop`).

Production `make` validation:

```bash
REQUIRE_PEAR_UPGRADE=1 npm run make
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Dev app, `--no-updates` |
| `npm run start:updates` | Dev with OTA |
| `npm test` | Protocol / room / engine tests |
| `npm run build:engine` | Bundle engine for Bare |
| `npm run package` | Electron Forge package |
| `npm run make` | Platform distributables |

## Layout

```text
pear-desktop/
  electron/          main + preload (Pear shell)
  workers/           Bare app core (OTA + P2P + logs)
    main.js
    session.js
    protocol.js
    room.js
    lib/engine.cjs   (generated)
  renderer/          lobby + board UI
  build/             icons, entitlements, AppxManifest
  forge.config.js
  pear.json          multisig config
  scripts/           engine bundle
  tests/
```

## Security notes

- Noise-encrypted peer sockets (Hyperswarm)  
- Room codes are invite secrets  
- Guests cannot forge board state  
- Host could still cheat (friends mode); match Hypercores enable later audit/replay  
- Multisig production drives are machine-independent write access  

## What “full Pear product” means here

| Capability | Status |
| --- | --- |
| Electron + sandboxed renderer | ✅ |
| Bare worker via pear-runtime | ✅ |
| Hyperswarm multiplayer | ✅ |
| Corestore + match Hypercore | ✅ |
| OTA updater events + apply | ✅ |
| Forge makers (dmg/zip/msix/AppImage) | ✅ |
| pear.json multisig scaffold | ✅ |
| Deploy docs (stage/provision/multisig) | ✅ |
| Live `pear://` key seeded | ⬜ run `pear touch` on your machine |
| Vendor code signing / notarization | ⬜ set env secrets for `make` |
| Mobile BareKit share of worker | ⬜ worker written CJS for future parity |

## License

MIT (game engine from parent Chennamane project).
