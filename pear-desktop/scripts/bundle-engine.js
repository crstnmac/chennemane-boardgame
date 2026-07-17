/**
 * Bundle parent TypeScript engine for Bare worker (CJS, platform-neutral).
 */
const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

const root = path.resolve(__dirname, '..')
const entry = path.resolve(root, '../src/engine/index.ts')
const outJs = path.resolve(root, 'workers/lib/engine.js')
const outCjs = path.resolve(root, 'workers/lib/engine.cjs')

fs.mkdirSync(path.dirname(outJs), { recursive: true })

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: 'neutral',
    format: 'cjs',
    outfile: outJs,
    sourcemap: true,
    logLevel: 'info',
  })
  .then(() => {
    // Keep .cjs copy for Node tests that require explicit CJS extension
    fs.copyFileSync(outJs, outCjs)
    if (fs.existsSync(outJs + '.map')) {
      fs.copyFileSync(outJs + '.map', outCjs + '.map')
    }
    console.log('bundled engine →', outJs)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
