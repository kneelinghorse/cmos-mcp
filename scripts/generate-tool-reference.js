#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m06 build hook — regenerate the committed top-level TOOL_REFERENCE.md
// from the COMPILED CMOS_TOOL_DEFINITIONS barrel (no server start, no DB, no network).

/**
 * Emit TOOL_REFERENCE.md from the compiled dist tool-definition barrel using the
 * shared renderer (the same function the freshness test uses on the src defs, so the
 * committed file and the gate agree byte-for-byte).
 *
 * Usage: node scripts/generate-tool-reference.js
 * Chained after tsc + generate-build-manifest.js by `npm run build`.
 */

const fs = require('fs');
const path = require('path');
const { renderToolReference } = require('./lib/render-tool-reference');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_BARREL = path.join(REPO_ROOT, 'dist', 'tools', 'cmos', 'index.js');
const OUTPUT_PATH = path.join(REPO_ROOT, 'TOOL_REFERENCE.md');

function main() {
  if (!fs.existsSync(DIST_BARREL)) {
    console.error(
      `[tool-reference] dist barrel missing at ${DIST_BARREL} — run tsc first (npm run build chains this after tsc).`
    );
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CMOS_TOOL_DEFINITIONS, CMOS_ACTION_PARAMS } = require(DIST_BARREL);
  if (!Array.isArray(CMOS_TOOL_DEFINITIONS) || CMOS_TOOL_DEFINITIONS.length === 0) {
    console.error('[tool-reference] CMOS_TOOL_DEFINITIONS is empty or not an array.');
    process.exit(1);
  }
  if (!CMOS_ACTION_PARAMS || typeof CMOS_ACTION_PARAMS !== 'object') {
    console.error(
      '[tool-reference] CMOS_ACTION_PARAMS is missing from the compiled barrel — the per-action ' +
        'tables cannot be rendered (s86-m04).'
    );
    process.exit(1);
  }

  const markdown = renderToolReference(CMOS_TOOL_DEFINITIONS, CMOS_ACTION_PARAMS);
  fs.writeFileSync(OUTPUT_PATH, markdown, 'utf8');
  console.error(
    `[tool-reference] Wrote TOOL_REFERENCE.md (${CMOS_TOOL_DEFINITIONS.length} tools, ${markdown.length} bytes)`
  );
}

main();
