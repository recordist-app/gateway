#!/usr/bin/env bash
# Builds the Claude Desktop Extension, an MCP Bundle: build/recordist-<version>.mcpb
#
#   bash scripts/build-mcpb.sh
#
# The bundle holds the compiled gateway (dist/), its production dependencies and mcpb/manifest.json.
# It carries no native code: better-sqlite3 is left out, so reads with Recordist closed use node:sqlite,
# which is built into the Node that Claude Desktop ships (Node 22.13 and later). Spec and CLI:
# https://github.com/modelcontextprotocol/mcpb
set -euo pipefail

MCPB="@anthropic-ai/mcpb@2.1.2"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(node -p "require('$root/package.json').version")
manifest_version=$(node -p "require('$root/mcpb/manifest.json').version")
if [[ $version != "$manifest_version" ]]; then
  echo "build-mcpb: package.json is $version but mcpb/manifest.json is $manifest_version" >&2
  exit 1
fi

stage="$root/build/mcpb"
out="$root/build/recordist-$version.mcpb"
rm -rf "$root/build"
mkdir -p "$stage"

(cd "$root" && npm run --silent clean && npm run --silent build)

cp "$root/mcpb/manifest.json" "$root/mcpb/icon.png" "$root/mcpb/.mcpbignore" "$stage/"
cp "$root/LICENSE" "$root/README.md" "$root/package.json" "$root/package-lock.json" "$stage/"
cp -R "$root/dist" "$stage/dist"

# Production dependencies at the locked versions, then better-sqlite3 and what only it needs.
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd "$stage" && npm uninstall better-sqlite3 --no-save --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
find "$stage/node_modules" -type d -empty -delete
if find "$stage/node_modules" -name '*.node' | grep -q .; then
  echo "build-mcpb: a native module is still in the bundle" >&2
  exit 1
fi

npx -y "$MCPB" validate "$stage/manifest.json"
npx -y "$MCPB" pack "$stage" "$out"
npx -y "$MCPB" info "$out"
shasum -a 256 "$out"
