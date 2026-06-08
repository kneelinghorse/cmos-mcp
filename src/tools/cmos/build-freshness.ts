// ABOUTME: Sprint 67 m03 — detect when dist/ is behind src/. Surfaces a "rebuild before
// ABOUTME: sessions" signal at sprint close and at cmos_review so agents stop marking missions
// ABOUTME: complete against stale runtime code (the s65 retro footgun this closes).

import { promises as fs } from 'fs';
import * as path from 'path';

/** Shape consumed by cmos_sprint_complete and cmos_review surfaces. */
export interface BuildFreshnessReport {
  stale: boolean;
  latestSrcMtime: string | null;
  distBuildTime: string | null;
  /** Up to 5 newest-first src files when stale. Omitted when fresh or on error. */
  staleFiles?: string[];
  /** Human-readable reason. Always present when stale=true; never when fresh. */
  reason?: string;
}

/**
 * The stale `reason` values that the enforced sprint-close gate (Sprint 70 m02)
 * treats as BLOCKING. These are exactly the reasons checkBuildFreshness emits with
 * stale=true. The never-throws I/O path emits `freshness-check-failed:<msg>` with
 * stale=false and is deliberately NOT in this set, so a probe failure can never
 * wedge a sprint close.
 */
const BLOCKING_STALENESS_REASONS: ReadonlySet<string> = new Set([
  'dist-missing',
  'src-newer-than-build-manifest',
  'src-newer-than-dist-index-mtime',
]);

/**
 * Decide whether a freshness report should BLOCK an enforced gate. True only when
 * the tree is stale AND the reason is one we classify as blocking — fresh trees,
 * the freshness-check-failed I/O path, and any future/unrecognized reason all
 * fall through to non-blocking (fail-open by default; the gate never wedges on a
 * shape it does not understand).
 */
export function isBlockingStaleness(report: BuildFreshnessReport): boolean {
  return (
    report.stale === true && report.reason != null && BLOCKING_STALENESS_REASONS.has(report.reason)
  );
}

const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);
const STALE_FILES_CAP = 5;
const SRC_WALK_CAP = 5000;
const BUILD_MANIFEST_RELATIVE = path.join('dist', '.build-manifest.json');
const DIST_FALLBACK_FILE = path.join('dist', 'index.js');

interface SrcFileMtime {
  relativePath: string;
  mtimeMs: number;
}

/**
 * Walk src/ collecting (relativePath, mtime) for .ts/.tsx/.js files. Skips
 * node_modules / dist / .git / coverage / .next. Caps at SRC_WALK_CAP files
 * to avoid pathological repos. Returns [] when src/ is missing.
 */
async function collectSrcMtimes(projectRoot: string): Promise<SrcFileMtime[]> {
  const srcDir = path.join(projectRoot, 'src');
  let exists = false;
  try {
    const stat = await fs.stat(srcDir);
    exists = stat.isDirectory();
  } catch {
    return [];
  }
  if (!exists) return [];

  const results: SrcFileMtime[] = [];
  const stack: string[] = [srcDir];
  while (stack.length > 0 && results.length < SRC_WALK_CAP) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (results.length >= SRC_WALK_CAP) break;
      const fullPath = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        // Permission error / symlink to nowhere — skip rather than crash.
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(fullPath);
      } else if (stat.isFile()) {
        const ext = path.extname(name);
        if (!SRC_EXTENSIONS.has(ext)) continue;
        results.push({
          relativePath: path.relative(projectRoot, fullPath),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  return results;
}

interface DistBuildInfo {
  buildTimeMs: number | null;
  source: 'manifest' | 'index-mtime' | 'missing';
}

async function readDistBuildInfo(projectRoot: string): Promise<DistBuildInfo> {
  const manifestPath = path.join(projectRoot, BUILD_MANIFEST_RELATIVE);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as { buildTime?: string };
    if (parsed && typeof parsed.buildTime === 'string') {
      const ms = Date.parse(parsed.buildTime);
      if (!Number.isNaN(ms)) {
        return { buildTimeMs: ms, source: 'manifest' };
      }
    }
  } catch {
    // Fall through to index.js mtime.
  }

  const indexPath = path.join(projectRoot, DIST_FALLBACK_FILE);
  try {
    const stat = await fs.stat(indexPath);
    return { buildTimeMs: stat.mtimeMs, source: 'index-mtime' };
  } catch {
    return { buildTimeMs: null, source: 'missing' };
  }
}

/**
 * Determine whether dist/ is behind src/. Never throws — all I/O errors fold
 * into a stale=false / reason='freshness-check-failed: <msg>' return so the
 * helper cannot block sprint close or review.
 */
export async function checkBuildFreshness(projectRoot: string): Promise<BuildFreshnessReport> {
  try {
    const [srcFiles, distInfo] = await Promise.all([
      collectSrcMtimes(projectRoot),
      readDistBuildInfo(projectRoot),
    ]);

    if (srcFiles.length === 0) {
      // src/ missing or empty — packages installed dist-only legitimately
      // hit this path. Defensive default: not stale.
      return {
        stale: false,
        latestSrcMtime: null,
        distBuildTime: distInfo.buildTimeMs ? new Date(distInfo.buildTimeMs).toISOString() : null,
      };
    }

    if (distInfo.source === 'missing') {
      const newestFirst = [...srcFiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
      return {
        stale: true,
        latestSrcMtime: new Date(newestFirst[0].mtimeMs).toISOString(),
        distBuildTime: null,
        staleFiles: newestFirst.slice(0, STALE_FILES_CAP).map((f) => f.relativePath),
        reason: 'dist-missing',
      };
    }

    const distMs = distInfo.buildTimeMs as number;
    const newer = srcFiles.filter((f) => f.mtimeMs > distMs);
    if (newer.length === 0) {
      const latestSrc = srcFiles.reduce((max, f) => (f.mtimeMs > max ? f.mtimeMs : max), 0);
      return {
        stale: false,
        latestSrcMtime: new Date(latestSrc).toISOString(),
        distBuildTime: new Date(distMs).toISOString(),
      };
    }

    const newestFirst = newer.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      stale: true,
      latestSrcMtime: new Date(newestFirst[0].mtimeMs).toISOString(),
      distBuildTime: new Date(distMs).toISOString(),
      staleFiles: newestFirst.slice(0, STALE_FILES_CAP).map((f) => f.relativePath),
      reason:
        distInfo.source === 'manifest'
          ? 'src-newer-than-build-manifest'
          : 'src-newer-than-dist-index-mtime',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      stale: false,
      latestSrcMtime: null,
      distBuildTime: null,
      reason: `freshness-check-failed: ${message}`,
    };
  }
}
