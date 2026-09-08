import type { ForgeConfig } from '@electron-forge/shared-types';
import { existsSync } from 'node:fs';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

if (process.env.SECOND_PASS_RELEASE === '1' && !existsSync('build/codex/vendor')) {
  throw new Error('Run pnpm prepare:codex before packaging a release.');
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: 'assets/second-pass',
    executableName: 'SecondPass',
    appBundleId: 'com.richardirg.secondpass',
    appCopyright: 'Copyright 2026 Richard Mancuso',
    extraResource: existsSync('build/codex/vendor') ? ['build/codex'] : [],
    ignore: [/^\/work($|\/)/, /^\/tests($|\/)/, /^\/docs($|\/)/, /^\/build($|\/)/, /^\/\.github($|\/)/, /^\/scripts($|\/)/],
    osxSign: {
      identity: '-',
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
    extendInfo: {
      NSDocumentsFolderUsageDescription: 'Second Pass needs access to HTML documents created in your Documents folder.',
      NSDownloadsFolderUsageDescription: 'Second Pass needs access to HTML documents saved in your Downloads folder.',
      NSDesktopFolderUsageDescription: 'Second Pass needs access to HTML documents saved on your Desktop.',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ name: 'Second Pass', format: 'ULFO', overwrite: true }),
    new MakerSquirrel({
      name: 'SecondPass',
      authors: 'Richard Mancuso',
      description: 'Edit text and images directly in HTML pages, with Codex beside you.',
      setupExe: 'Second-Pass-Windows-x64-Setup.exe',
      setupIcon: 'assets/second-pass.ico',
      noMsi: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    }),
  ],
};

export default config;
