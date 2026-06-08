// ABOUTME: One-shot CLI to validate + prune dead entries from ~/.config/cmos-mcp/project-registry.json.
// ABOUTME: Mirrors the server-startup auto-prune so operators can drain the registry between runs.

import { ProjectRegistry } from '../src/intelligence/project-registry';

async function main(): Promise<number> {
  const registry = await ProjectRegistry.create();
  const before = await registry.list();
  console.log(`[prune] ${before.length} entries in ${registry.path}`);

  const validations = await registry.validate();
  const stale = validations.filter((v) => v.status !== 'active');

  if (stale.length === 0) {
    console.log('[prune] registry is clean, nothing to remove');
    return 0;
  }

  console.log(`[prune] removing ${stale.length} stale/missing entries:`);
  for (const v of stale.slice(0, 20)) {
    console.log(`  - [${v.status}] ${v.project.projectRoot}`);
  }
  if (stale.length > 20) {
    console.log(`  ... and ${stale.length - 20} more`);
  }

  const removed = await registry.prune();
  const after = await registry.list();
  console.log(`[prune] removed ${removed} entries; ${after.length} remain`);
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
