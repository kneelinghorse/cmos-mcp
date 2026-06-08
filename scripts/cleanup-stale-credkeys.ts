#!/usr/bin/env npx ts-node
// ABOUTME: Sprint 67 m05 — operator-run helper to identify (dry-run) and optionally prune
// ABOUTME: project-scoped credential keys whose project root is absent from both the project
// ABOUTME: registry and the filesystem. Run: `npx tsx scripts/cleanup-stale-credkeys.ts [--prune]`.

import * as fs from 'fs';
import * as path from 'path';
import { CredentialStore } from '../src/intelligence/credential-store';
import { ProjectRegistry } from '../src/intelligence/project-registry';

interface CleanupRow {
  keyId: string;
  projectRoot: string;
  inRegistry: boolean;
  onDisk: boolean;
  recommendation: 'stale-remove' | 'keep';
}

export interface CleanupSummary {
  total: number;
  stale: number;
  removed: number;
  kept: number;
  rows: CleanupRow[];
}

export interface CleanupOptions {
  prune?: boolean;
  /** Override config directory (defaults to env-aware ProjectRegistry/CredentialStore default). */
  configDir?: string;
}

/**
 * Identify stale project-scoped credential keys. A key is stale whenever EITHER
 * the project registry OR the filesystem fails to vouch for its projectRoot —
 * both signals must affirm presence to mark the key as kept. The conservative
 * read would be "only stale when both fail," but per the mission spec all three
 * anomaly branches (registered+missing-fs, on-disk+unregistered, both-missing)
 * surface in the report so the operator sees what's drifted.
 *
 * Pass `prune: true` to remove the stale rows via CredentialStore.removeProjectKey
 * (s66-m06's mtime-based cache invalidation in CredentialStore.load() makes this
 * safe for a long-running MCP process — the next load() picks up the change).
 */
export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupSummary> {
  CredentialStore.resetInstance();
  ProjectRegistry.resetInstance();

  const credStore = await CredentialStore.create({ configDir: options.configDir });
  const registry = await ProjectRegistry.create({ configDir: options.configDir });

  const projectKeys = await credStore.listProjectKeys();
  const registeredProjects = await registry.list();
  const registeredRoots = new Set(registeredProjects.map((p) => path.resolve(p.projectRoot)));

  const rows: CleanupRow[] = [];
  let removed = 0;
  let stale = 0;
  let kept = 0;

  for (const [projectRoot, record] of Object.entries(projectKeys)) {
    const resolvedRoot = path.resolve(projectRoot);
    const inRegistry = registeredRoots.has(resolvedRoot);
    const onDisk = fs.existsSync(resolvedRoot);
    const isStale = !inRegistry || !onDisk;
    const recommendation: CleanupRow['recommendation'] = isStale ? 'stale-remove' : 'keep';
    if (isStale) {
      stale++;
      if (options.prune) {
        await credStore.removeProjectKey(resolvedRoot);
        removed++;
      }
    } else {
      kept++;
    }
    rows.push({
      keyId: record.keyId,
      projectRoot: resolvedRoot,
      inRegistry,
      onDisk,
      recommendation,
    });
  }

  return {
    total: Object.keys(projectKeys).length,
    stale,
    removed,
    kept,
    rows,
  };
}

// ─── CLI rendering ───────────────────────────────────────────────────────────

function abbreviateKey(keyId: string): string {
  return keyId.length > 8 ? `${keyId.slice(0, 8)}…` : keyId;
}

function abbreviatePath(p: string, max = 40): string {
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

function renderTable(summary: CleanupSummary, prune: boolean): string {
  const header = ['keyId', 'projectRoot', 'inRegistry', 'onDisk', 'recommendation'];
  const widths = [10, 42, 11, 7, 16];
  const headerLine = header.map((h, i) => h.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [headerLine, sep];
  for (const row of summary.rows) {
    lines.push(
      [
        abbreviateKey(row.keyId).padEnd(widths[0]),
        abbreviatePath(row.projectRoot, 40).padEnd(widths[1]),
        String(row.inRegistry).padEnd(widths[2]),
        String(row.onDisk).padEnd(widths[3]),
        row.recommendation.padEnd(widths[4]),
      ].join('  ')
    );
  }
  lines.push('');
  const footer = prune
    ? `Summary: total=${summary.total}, stale=${summary.stale}, removed=${summary.removed}, kept=${summary.kept}`
    : `Summary: total=${summary.total}, stale=${summary.stale} (dry-run; pass --prune to remove)`;
  lines.push(footer);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const prune = process.argv.includes('--prune');
  const summary = await runCleanup({ prune });

  process.stdout.write(renderTable(summary, prune) + '\n');
  // Trailing structured JSON for tooling that wants to parse the result.
  process.stdout.write(
    '\n' +
      JSON.stringify(
        {
          total: summary.total,
          stale: summary.stale,
          removed: prune ? summary.removed : undefined,
          kept: summary.kept,
        },
        null,
        2
      ) +
      '\n'
  );
}

// Only run main() when executed directly, not when imported by tests.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`cleanup-stale-credkeys failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
