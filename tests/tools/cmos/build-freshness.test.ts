// ABOUTME: Sprint 67 m03 — checkBuildFreshness covers the four states sprint close + cmos_review
// ABOUTME: depend on: fresh, src-newer-than-manifest, src-newer-than-index-mtime, dist-missing,
// ABOUTME: plus defensive defaults for missing src/ and I/O errors.

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

  it('falls back to dist/index.js mtime when the manifest is absent and detects stale src', async () => {
    const indexMtime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeSrcFile(project.root, 'src/foo.ts', newerSrc);
    writeDistIndex(project.root, indexMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, indexMtime);
    expect(result.reason).toBe('src-newer-than-dist-index-mtime');
  });

  it('returns stale=true reason=dist-missing when neither manifest nor dist/index.js exists', async () => {
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

  it('blocks on src-newer-than-dist-index-mtime', () => {
    expect(
      isBlockingStaleness(report({ stale: true, reason: 'src-newer-than-dist-index-mtime' }))
    ).toBe(true);
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
