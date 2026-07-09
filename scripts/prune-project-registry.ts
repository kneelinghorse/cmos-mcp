// ABOUTME: One-shot CLI to archive dead entries from the project-graph registry
// ABOUTME: (~/.config/cmos-mcp/project-graph.sqlite). Mirrors the server-startup auto-prune.

import { existsSync } from 'fs';
import path from 'path';
import { ProjectGraphRegistry } from '../src/intelligence/project-graph-registry';

async function main(): Promise<number> {
  // s80-m02: the project-graph registry is the single discovery source (the JSON
  // ProjectRegistry was deleted). Prune = archive rows whose store's cmos.sqlite is gone.
  const graph = await ProjectGraphRegistry.create();
  const before = graph.list();
  console.log(`[prune] ${before.length} entries in ${graph.path}`);

  const stale = before.filter(
    (e) => !existsSync(path.join(e.store_path, 'cmos', 'db', 'cmos.sqlite'))
  );

  if (stale.length === 0) {
    console.log('[prune] registry is clean, nothing to remove');
    return 0;
  }

  console.log(`[prune] archiving ${stale.length} stale/missing entries:`);
  for (const e of stale.slice(0, 20)) {
    console.log(`  - ${e.store_path}`);
  }
  if (stale.length > 20) {
    console.log(`  ... and ${stale.length - 20} more`);
  }

  const removed = graph.pruneMissingStores();
  const after = graph.list();
  console.log(`[prune] archived ${removed} entries; ${after.length} remain`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[prune] failed:', err);
      process.exit(1);
    });
}

export { main as pruneProjectRegistry };
