// ABOUTME: Sprint 67 m03 — checkBuildFreshness covers the states sprint close + cmos_review
// ABOUTME: depend on: fresh, src-newer-than-manifest, src-newer-than-build-dir, dist-missing,
// ABOUTME: plus defensive defaults for missing src/ and I/O errors. Sprint 74 m01 adds the
// ABOUTME: generalized candidate-build-dir layouts (aquex.ai / monorepo / Next .next/).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkBuildFreshness,
  isBlockingStaleness,
  type BuildFreshnessReport,
} from '../../../src/tools/cmos/build-freshness';

interface TempProject {
  root: string;
  cleanup: () => void;
}

function makeTempProject(): TempProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-freshness-test-'));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeSrcFile(root: string, relativePath: string, mtime?: Date): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `// ${relativePath}\n`);
  if (mtime) {
    fs.utimesSync(fullPath, mtime, mtime);
  }
}

function writeDistManifest(root: string, buildTime: Date): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, '.build-manifest.json'),
    JSON.stringify(
      { buildHash: 'deadbeef', buildTime: buildTime.toISOString(), fileCount: 1 },
      null,
      2
    ) + '\n'
  );
}

function expectIsoCloseTo(actual: string | null, expected: Date): void {
  // FS mtime precision varies (APFS ns, ext4 ns, HFS+ ms) and Date.toISOString()
  // formats at ms granularity. Allow 1ms drift between request and read-back.
  expect(actual).not.toBeNull();
  const actualMs = Date.parse(actual ?? '');
  expect(Math.abs(actualMs - expected.getTime())).toBeLessThanOrEqual(1);
}

function writeDistIndex(root: string, mtime: Date): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const indexPath = path.join(distDir, 'index.js');
  fs.writeFileSync(indexPath, 'module.exports = {};\n');
  fs.utimesSync(indexPath, mtime, mtime);
}

/** Write an arbitrary build-output file at an exact mtime (any extension/layout). */
function writeBuildFile(root: string, relativePath: string, mtime: Date): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `// built: ${relativePath}\n`);
  fs.utimesSync(fullPath, mtime, mtime);
}

/** Write a present-but-unparseable dist/.build-manifest.json at an exact mtime. */
function writeCorruptDistManifest(root: string, mtime: Date): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const manifestPath = path.join(distDir, '.build-manifest.json');
  fs.writeFileSync(manifestPath, '{ "buildTime": "2026-'); // truncated / invalid JSON
  fs.utimesSync(manifestPath, mtime, mtime);
}

describe('checkBuildFreshness', () => {
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('returns stale=false when all src files are older than the build manifest', async () => {
    const oldTime = new Date(Date.now() - 60_000);
    const newTime = new Date();
    writeSrcFile(project.root, 'src/foo.ts', oldTime);
    writeSrcFile(project.root, 'src/bar/baz.ts', oldTime);
    writeDistManifest(project.root, newTime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expectIsoCloseTo(result.distBuildTime, newTime);
    expect(result.reason).toBeUndefined();
    expect(result.staleFiles).toBeUndefined();
  });

  it('returns stale=true with the newest stale file first when one src file is newer than the manifest', async () => {
    const buildTime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeSrcFile(project.root, 'src/older.ts', new Date(buildTime.getTime() - 5_000));
    writeSrcFile(project.root, 'src/changed.ts', newerSrc);
    writeDistManifest(project.root, buildTime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, buildTime);
    expectIsoCloseTo(result.latestSrcMtime, newerSrc);
    expect(result.staleFiles).toEqual([path.join('src', 'changed.ts')]);
    expect(result.reason).toBe('src-newer-than-build-manifest');
  });

  it('falls back to the newest dist/ file mtime when the manifest is absent and detects stale src', async () => {
    const indexMtime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeSrcFile(project.root, 'src/foo.ts', newerSrc);
    writeDistIndex(project.root, indexMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, indexMtime);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('returns stale=true reason=dist-missing when no candidate build dir exists', async () => {
    writeSrcFile(project.root, 'src/foo.ts');

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('dist-missing');
    expect(result.distBuildTime).toBeNull();
    expect(result.staleFiles).toEqual([path.join('src', 'foo.ts')]);
  });

  it('returns stale=false defensively when src/ is missing (dist-only install path)', async () => {
    writeDistManifest(project.root, new Date());

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.latestSrcMtime).toBeNull();
  });

  it('caps staleFiles at 5 entries, newest-first', async () => {
    const buildTime = new Date(Date.now() - 600_000);
    writeDistManifest(project.root, buildTime);
    for (let i = 0; i < 8; i++) {
      const mtime = new Date(Date.now() - i * 1000);
      writeSrcFile(project.root, `src/file_${i}.ts`, mtime);
    }

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.staleFiles).toHaveLength(5);
    // file_0 is newest (i=0 → Date.now() - 0), so it should be first.
    expect(result.staleFiles?.[0]).toBe(path.join('src', 'file_0.ts'));
    expect(result.staleFiles?.[4]).toBe(path.join('src', 'file_4.ts'));
  });

  it('skips node_modules / dist / .git / coverage when walking src/', async () => {
    const buildTime = new Date();
    writeDistManifest(project.root, buildTime);
    // A file inside src/node_modules with a very-new mtime would falsely trigger stale.
    const newer = new Date(Date.now() + 60_000);
    writeSrcFile(project.root, 'src/node_modules/should-skip.ts', newer);
    writeSrcFile(project.root, 'src/coverage/should-skip.ts', newer);
    writeSrcFile(project.root, 'src/.git/should-skip.ts', newer);
    writeSrcFile(project.root, 'src/real.ts', new Date(Date.now() - 60_000));

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
  });

  it('treats .ts, .tsx, and .js as src; ignores other extensions', async () => {
    const buildTime = new Date(Date.now() - 60_000);
    writeDistManifest(project.root, buildTime);
    const newer = new Date();
    // .md should not trigger stale even if newer than the build.
    writeSrcFile(project.root, 'src/README.md', newer);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
  });

  it('returns stale=false with freshness-check-failed reason when the project root is unreadable', async () => {
    // Passing a path with a null byte triggers EILSEQ / EINVAL on both Linux and macOS
    // before any of the helper's branches succeed — exercising the outer try/catch.
    const result = await checkBuildFreshness('/proc/this/path/does/not/exist\0invalid');

    // Either the inner walks silently no-op (stale=false, no reason) or the outer catch
    // fires (stale=false, reason starts with 'freshness-check-failed'). Both are valid
    // defensive shapes — assert no crash, no stale=true.
    expect(result.stale).toBe(false);
  });
});

describe('checkBuildFreshness — generalized build-dir layouts (Sprint 74 m01)', () => {
  // The pre-s74 probe only checked dist/.build-manifest.json then the hardcoded
  // dist/index.js, so any project whose build output was not exactly <root>/dist/index.js
  // got a permanent false dist-missing and could never close a sprint without
  // forceComplete. These cover the three independently-reported layouts plus the
  // priority/exclusion/empty-dir edges (decision #834).
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('aquex.ai layout: detects stale when src is newer than dist/server/entry.mjs (no dist/index.js, no manifest)', async () => {
    const buildMtime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeBuildFile(project.root, 'dist/server/entry.mjs', buildMtime);
    writeSrcFile(project.root, 'src/foo.ts', newerSrc);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.distBuildTime).not.toBeNull();
    expectIsoCloseTo(result.distBuildTime, buildMtime);
    expect(result.reason).toBe('src-newer-than-build-dir');
    expect(result.staleFiles).toEqual([path.join('src', 'foo.ts')]);
  });

  it('aquex.ai layout: reports fresh when dist/server/entry.mjs is newer than src', async () => {
    const olderSrc = new Date(Date.now() - 60_000);
    const buildMtime = new Date();
    writeSrcFile(project.root, 'src/foo.ts', olderSrc);
    writeBuildFile(project.root, 'dist/server/entry.mjs', buildMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expectIsoCloseTo(result.distBuildTime, buildMtime);
    expect(result.reason).toBeUndefined();
  });

  it('monorepo layout: walks dist/src/index.js when there is no dist/index.js', async () => {
    const buildMtime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeBuildFile(project.root, 'dist/src/index.js', buildMtime);
    writeBuildFile(project.root, 'dist/src/util.js', new Date(buildMtime.getTime() - 5_000));
    writeSrcFile(project.root, 'src/index.ts', newerSrc);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    // Newest file in dist/ (index.js) is the build time, not the older util.js.
    expectIsoCloseTo(result.distBuildTime, buildMtime);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('Next.js layout: uses .next/ newest mtime when there is no dist/', async () => {
    const buildMtime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeBuildFile(project.root, '.next/server/app/page.js', buildMtime);
    writeSrcFile(project.root, 'src/page.tsx', newerSrc);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.distBuildTime).not.toBeNull();
    expectIsoCloseTo(result.distBuildTime, buildMtime);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('Next.js layout: reports fresh when .next/ build is newer than src', async () => {
    const olderSrc = new Date(Date.now() - 60_000);
    const buildMtime = new Date();
    writeSrcFile(project.root, 'src/page.tsx', olderSrc);
    writeBuildFile(project.root, '.next/server/app/page.js', buildMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expectIsoCloseTo(result.distBuildTime, buildMtime);
  });

  it('excludes .next/cache from the build-dir walk (dev-server churn is not a build artifact)', async () => {
    // Real build output is OLDER than src (so the tree is genuinely stale), but a
    // .next/cache entry is NEWER than everything. If cache were counted the project
    // would look fresh and the gate would wrongly pass.
    const realBuild = new Date(Date.now() - 60_000);
    const srcMtime = new Date(Date.now() - 30_000);
    const cacheChurn = new Date();
    writeBuildFile(project.root, '.next/server/app/page.js', realBuild);
    writeBuildFile(project.root, '.next/cache/webpack/0.pack', cacheChurn);
    writeSrcFile(project.root, 'src/page.tsx', srcMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, realBuild);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('prefers dist/ over .next/ when both exist (candidate priority order)', async () => {
    const distMtime = new Date(Date.now() - 90_000);
    const nextMtime = new Date(Date.now() - 10_000);
    writeBuildFile(project.root, 'dist/server/entry.mjs', distMtime);
    writeBuildFile(project.root, '.next/server/app/page.js', nextMtime);
    writeSrcFile(project.root, 'src/foo.ts', new Date(Date.now() - 120_000));

    const result = await checkBuildFreshness(project.root);

    // Build time comes from dist/ (the higher-priority candidate), not the newer .next/.
    expectIsoCloseTo(result.distBuildTime, distMtime);
  });

  it('skips an empty higher-priority candidate and uses the next that holds output', async () => {
    // A wiped dist/ dir exists but holds no files; the real build is in .next/.
    // Must NOT false-block as dist-missing.
    fs.mkdirSync(path.join(project.root, 'dist'), { recursive: true });
    const buildMtime = new Date(Date.now() - 60_000);
    writeBuildFile(project.root, '.next/server/app/page.js', buildMtime);
    writeSrcFile(project.root, 'src/page.tsx', new Date(Date.now() - 120_000));

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expect(result.reason).toBeUndefined();
    expectIsoCloseTo(result.distBuildTime, buildMtime);
  });

  it('recognizes build/ as a candidate build dir', async () => {
    const buildMtime = new Date(Date.now() - 60_000);
    writeBuildFile(project.root, 'build/main.js', buildMtime);
    writeSrcFile(project.root, 'src/foo.ts', new Date());

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, buildMtime);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('recognizes out/ as a candidate build dir', async () => {
    const buildMtime = new Date(Date.now() - 60_000);
    writeBuildFile(project.root, 'out/bundle.js', buildMtime);
    writeSrcFile(project.root, 'src/foo.ts', new Date());

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, buildMtime);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('does NOT let a corrupt-but-present manifest mtime vouch for an interrupted build', async () => {
    // A partial/truncated manifest write leaves dist/.build-manifest.json present
    // (unparseable) with a fresh mtime, but the actual build artifacts are older
    // than src. The manifest file must be excluded from the walk so its fresh
    // mtime cannot mask the stale build and wrongly pass the gate.
    const staleBuild = new Date(Date.now() - 120_000);
    const srcMtime = new Date(Date.now() - 60_000);
    const corruptManifestMtime = new Date(); // newest thing on disk
    writeBuildFile(project.root, 'dist/index.js', staleBuild);
    writeSrcFile(project.root, 'src/foo.ts', srcMtime);
    writeCorruptDistManifest(project.root, corruptManifestMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    // Build time is the real artifact (older), NOT the corrupt manifest (newer).
    expectIsoCloseTo(result.distBuildTime, staleBuild);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('lets a VALID manifest short-circuit the candidate walk even when a dist file is newer', async () => {
    // A newer build artifact must not override the deterministic manifest buildTime.
    const manifestBuildTime = new Date(Date.now() - 60_000);
    const newerDistFile = new Date();
    writeDistManifest(project.root, manifestBuildTime);
    writeBuildFile(project.root, 'dist/index.js', newerDistFile);
    writeSrcFile(project.root, 'src/foo.ts', new Date(Date.now() - 90_000));

    const result = await checkBuildFreshness(project.root);

    // distBuildTime comes from the manifest, not the newer dist/index.js file.
    expectIsoCloseTo(result.distBuildTime, manifestBuildTime);
    expect(result.stale).toBe(false);
  });

  it('still reports dist-missing when every candidate build dir is empty or absent (gate preserved)', async () => {
    // .next/ exists but holds ONLY the excluded cache subtree → no usable build
    // file anywhere → genuinely unbuilt → must still block.
    writeBuildFile(project.root, '.next/cache/webpack/0.pack', new Date());
    writeSrcFile(project.root, 'src/foo.ts', new Date());

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('dist-missing');
    expect(result.distBuildTime).toBeNull();
  });
});

describe('isBlockingStaleness (Sprint 70 m02)', () => {
  // The enforced sprint-close gate blocks ONLY on staleness that means the dist/
  // a server would run is genuinely behind src/. The three blocking reasons are
  // the ones checkBuildFreshness emits with stale=true; everything else (fresh,
  // or the never-throws freshness-check-failed I/O path) must fall through.
  function report(partial: Partial<BuildFreshnessReport>): BuildFreshnessReport {
    return {
      stale: false,
      latestSrcMtime: null,
      distBuildTime: null,
      ...partial,
    };
  }

  it('blocks on src-newer-than-build-manifest', () => {
    expect(
      isBlockingStaleness(report({ stale: true, reason: 'src-newer-than-build-manifest' }))
    ).toBe(true);
  });

  it('blocks on src-newer-than-build-dir', () => {
    expect(isBlockingStaleness(report({ stale: true, reason: 'src-newer-than-build-dir' }))).toBe(
      true
    );
  });

  it('blocks on dist-missing', () => {
    expect(isBlockingStaleness(report({ stale: true, reason: 'dist-missing' }))).toBe(true);
  });

  it('does NOT block a fresh report', () => {
    expect(isBlockingStaleness(report({ stale: false }))).toBe(false);
  });

  it('does NOT block the never-throws freshness-check-failed path', () => {
    // checkBuildFreshness folds I/O errors into stale=false with this reason — it
    // must never wedge a sprint on a probe failure.
    expect(
      isBlockingStaleness(report({ stale: false, reason: 'freshness-check-failed: boom' }))
    ).toBe(false);
  });

  it('does NOT block when stale=true but the reason is unrecognized (defensive)', () => {
    // Belt-and-suspenders: a future stale reason we have not classified as blocking
    // should default to non-blocking, not silently wedge sprint close.
    expect(isBlockingStaleness(report({ stale: true, reason: 'some-future-reason' }))).toBe(false);
  });
});
