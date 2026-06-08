#!/usr/bin/env node

/**
 * Generate build manifest for MCP server staleness detection.
 *
 * Computes a SHA-256 hash of all compiled JS files in dist/ and writes
 * dist/.build-manifest.json with the hash + timestamp. Used by the server
 * health module to detect when running code is stale.
 *
 * Usage: node scripts/generate-build-manifest.js
 * Called automatically by `npm run build`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, '.build-manifest.json');

/**
 * Recursively collect all .js files in a directory, sorted for determinism.
 */
function collectJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error('[build-manifest] dist/ not found — skipping manifest generation');
    process.exit(0);
  }

  const jsFiles = collectJsFiles(DIST_DIR);
  if (jsFiles.length === 0) {
    console.error('[build-manifest] No .js files found in dist/');
    process.exit(0);
  }

  // Compute composite hash of all JS file contents
  const hash = crypto.createHash('sha256');
  for (const filePath of jsFiles) {
    const content = fs.readFileSync(filePath);
    // Include relative path in hash so renames are detected
    const relPath = path.relative(DIST_DIR, filePath);
    hash.update(relPath);
    hash.update(content);
  }

  const manifest = {
    buildHash: hash.digest('hex'),
    buildTime: new Date().toISOString(),
    fileCount: jsFiles.length,
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.error(
    `[build-manifest] Generated: hash=${manifest.buildHash.slice(0, 12)}… files=${manifest.fileCount} time=${manifest.buildTime}`
  );
}

main();
