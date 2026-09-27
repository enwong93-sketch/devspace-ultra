#!/usr/bin/env bash
set -euo pipefail

echo "DevSpace Ultra installer"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js >=22.19 and <27, then run this installer again." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required and should be installed with Node.js." >&2
  exit 1
fi

node_version="$(node --version | sed 's/^v//')"
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || major >= 27 || (major === 22 && minor < 19)) {
  console.error(`Unsupported Node.js ${process.versions.node}. DevSpace Ultra requires >=22.19 and <27.`);
  process.exit(1);
}
'

echo "Node.js ${node_version} detected."
release_tag="${DEVSPACE_RELEASE_TAG:-v0.5.9}"
if [[ ! "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "DEVSPACE_RELEASE_TAG must be an exact stable tag such as v0.5.9." >&2
  exit 1
fi
install_tmp="$(mktemp -d)"
trap 'rm -rf -- "$install_tmp"' EXIT
archive="$install_tmp/devspace-ultra-${release_tag#v}.tgz"

echo "Downloading and verifying DevSpace Ultra ${release_tag}..."
node - "$release_tag" "$archive" <<'NODE'
const [tag, destination] = process.argv.slice(2);
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const repo = 'enwong93-sketch/devspace-ultra';
const expectedName = `devspace-ultra-${tag.slice(1)}.tgz`;
const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'DevSpace-Ultra-Installer' };
(async () => {
  const metadataResponse = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
  if (!metadataResponse.ok) throw new Error(`GitHub Release lookup failed: HTTP ${metadataResponse.status}`);
  const release = await metadataResponse.json();
  if (release.draft || release.prerelease || release.tag_name !== tag) throw new Error('Release is not the exact stable tag.');
  const assets = release.assets.filter(asset => asset.name === expectedName);
  if (assets.length !== 1) throw new Error(`Release must contain exactly one ${expectedName}.`);
  const asset = assets[0];
  const expected = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Release archive has no valid SHA-256 digest.');
  const expectedPrefix = `https://github.com/${repo}/releases/download/${tag}/`;
  if (!String(asset.browser_download_url).startsWith(expectedPrefix)) throw new Error('Release asset URL is outside the expected tag.');
  const archiveResponse = await fetch(asset.browser_download_url, { headers });
  if (!archiveResponse.ok) throw new Error(`Release archive download failed: HTTP ${archiveResponse.status}`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error('Release archive SHA-256 mismatch.');
  writeFileSync(destination, bytes, { mode: 0o600 });
})().catch(error => { console.error(error.message); process.exit(1); });
NODE

echo "Installing verified DevSpace Ultra archive..."
npm install -g "$archive" --ignore-scripts --no-audit --no-fund
package_root="$(npm root -g)/devspace-ultra"
node - "$package_root" "${release_tag#v}" <<'NODE'
const [root, expectedVersion] = process.argv.slice(2);
const { existsSync } = require('node:fs');
const manifest = require(`${root}/package.json`);
if (manifest.name !== 'devspace-ultra' || manifest.version !== expectedVersion || !existsSync(`${root}/dist/cli.js`)) {
  throw new Error('Installed package identity, version, or CLI is incomplete.');
}
NODE
npm rebuild better-sqlite3 --prefix "$package_root" --ignore-scripts=false --no-audit --no-fund
node - "$package_root/node_modules/better-sqlite3" <<'NODE'
const DB = require(process.argv[2]);
const db = new DB(':memory:');
db.close();
NODE

if ! command -v devspace-ultra >/dev/null 2>&1; then
  echo "Installation completed but devspace-ultra is not on PATH. Restart the shell and try again." >&2
  exit 1
fi

echo "DevSpace Ultra ${release_tag} core package installed and native SQLite verified."
case "$(uname -s 2>/dev/null || true)" in
  Darwin)
    echo "macOS: base DevSpace and Chat Swarm are supported. Autonomous Windows AppX ChatGPT Classic runtime cloning is not available on macOS."
    ;;
  Linux)
    echo "Linux: base DevSpace and Chat Swarm are supported. Autonomous Windows AppX ChatGPT Classic runtime cloning is not available on Linux."
    ;;
esac

echo
echo "Next:"
echo "  devspace-ultra init"
echo "  devspace-ultra serve"
echo
echo "The compatibility alias 'devspace' is also installed."
