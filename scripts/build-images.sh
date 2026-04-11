#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${1:-$ROOT_DIR/system.json}"

echo "=== Building agent-vm images ==="

echo "[1/4] Building TypeScript packages..."
cd "$ROOT_DIR"
pnpm -r build

echo "[2/4] Building gateway OCI image..."
docker build -t agent-vm-gateway:latest "$ROOT_DIR/images/gateway"

echo "[3/4] Building tool OCI image..."
docker build -t agent-vm-tool:latest "$ROOT_DIR/images/tool"

echo "[4/4] Building Gondolin VM assets..."
# Use gondolin-core's buildImage (which lazy-loads @earendil-works/gondolin internally)
# instead of importing @earendil-works/gondolin directly — the latter is a linked local
# dep that node -e cannot resolve outside the workspace package context.
node --input-type=module -e "
  import { buildImage } from '$ROOT_DIR/packages/gondolin-core/dist/build-pipeline.js';
  import fs from 'node:fs';
  import path from 'node:path';

  try {
    const configPath = path.resolve('${CONFIG_PATH}');
    const configDir = path.dirname(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!config.zones?.length) {
      throw new Error('system.json defines no zones — nothing to build.');
    }

    function resolvePath(pathValue) {
      return path.isAbsolute(pathValue) ? pathValue : path.resolve(configDir, pathValue);
    }

    async function build(imageName, buildConfigPath, cacheDir) {
      try {
        const buildConfig = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'));
        const buildConfigDir = path.dirname(path.resolve(buildConfigPath));
        console.log('  Building ' + imageName + ' → ' + cacheDir);
        const result = await buildImage({ buildConfig, cacheDir, configDir: buildConfigDir });
        console.log('  ' + imageName + (result.built ? ' built' : ' cached') + ' (fingerprint: ' + result.fingerprint + ')');
      } catch (error) {
        throw new Error('Failed to build ' + imageName + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    const gatewayBuildConfigPath = resolvePath(config.images.gateway.buildConfig);
    const toolBuildConfigPath = resolvePath(config.images.tool.buildConfig);

    for (const zone of config.zones) {
      const zoneStateDir = resolvePath(zone.gateway.stateDir);
      await build(
        'gateway (' + zone.id + ')',
        gatewayBuildConfigPath,
        path.join(zoneStateDir, 'images', 'gateway'),
      );
      await build(
        'tool (' + zone.id + ')',
        toolBuildConfigPath,
        path.join(zoneStateDir, 'images', 'tool'),
      );
    }
  } catch (error) {
    console.error('[build-images] ' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
"

echo
echo "=== All images built ==="
