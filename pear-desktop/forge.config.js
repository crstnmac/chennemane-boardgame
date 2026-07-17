const fs = require('fs')
const path = require('path')

const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name

function getWindowsKitVersion() {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .pop()
      if (version) return version
    }
  } catch {
    return undefined
  }
}

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  ignore: [
    /^\/(\.git|tests|out|todo)(\/|$)/,
    /^\/scripts(\/|$)/,
    /\.test\.js$/,
    /\.md$/,
  ],
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist'),
      }),
    },
    osxNotarize: process.env.KEYCHAIN_PROFILE
      ? {
          tool: 'notarytool',
          keychainProfile: process.env.KEYCHAIN_PROFILE,
        }
      : undefined,
  }
}

module.exports = {
  packagerConfig,
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        appManifest: path.join(__dirname, 'build', 'AppxManifest.xml'),
        windowsKitVersion: getWindowsKitVersion(),
      },
    },
    {
      name: 'pear-electron-forge-maker-appimage',
      platforms: ['linux'],
      config: {
        icons: [
          { file: 'build/icon/icon-16x16.png', size: 16 },
          { file: 'build/icon/icon-32x32.png', size: 32 },
          { file: 'build/icon/icon-64x64.png', size: 64 },
          { file: 'build/icon/icon-128x128.png', size: 128 },
          { file: 'build/icon/icon-256x256.png', size: 256 },
        ],
      },
    },
  ],
  hooks: {
    readPackageJson: async (_forgeConfig, packageJson) => {
      if (process.env.UPGRADE_KEY) {
        packageJson.upgrade = process.env.UPGRADE_KEY
      }
      // Allow local make without a real pear:// key; require it only when packaging for deploy
      if (process.env.REQUIRE_PEAR_UPGRADE === '1') {
        try {
          const plink = require('pear-link')
          plink.parse(packageJson.upgrade)
        } catch {
          throw new Error(
            'Set package.json#upgrade with `pear touch` (or UPGRADE_KEY=) before production make',
          )
        }
      }
      return packageJson
    },
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })
      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      if (fs.existsSync(manifest)) {
        const msixVersion = pkg.version.replace(/^(\d+\.\d+\.\d+)$/, '$1.0')
        const xml = fs.readFileSync(manifest, 'utf-8')
        fs.writeFileSync(manifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
      }
    },
  },
  plugins: [
    {
      name: 'electron-forge-plugin-universal-prebuilds',
      config: {},
    },
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {},
    },
  ],
}
