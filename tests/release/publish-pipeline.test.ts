import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

type PackageJsonExports = {
  [key: string]:
    | string
    | {
        types?: string;
        require?: string;
        default?: string;
      };
};

type PackageJson = {
  main?: string;
  types?: string;
  exports?: PackageJsonExports;
  files?: string[];
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

const projectRoot = path.resolve(__dirname, '..', '..');
const PRIVATE = requiresPrivateEvidence({
  reason: 'publish workflow is intentionally private-source-only',
  paths: { workflow: '.github/workflows/publish.yml' },
});

function readTextFile(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('npm publish pipeline configuration', () => {
  test('package.json exposes dist entry points and declaration files', () => {
    const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

    expect(packageJson.main).toBe('dist/index.js');
    expect(packageJson.types).toBe('dist/index.d.ts');
    expect(packageJson.files).toContain('dist');
    expect(packageJson.bin).toMatchObject({
      'cmos-mcp': './dist/index.js',
    });

    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    });
  });

  // Arc C / s78-m01 (FORK-1 = A, hard-delete): the unauthenticated HTTP transport
  // (`cmos-mcp-http` bin, `./http-server` export, `start:http` script, `src/http-server.ts`)
  // was removed — it was a CORS-`*`, zero-auth, full-store-write channel with no consumers.
  // This guard is INVERTED from the old "must expose the http bin" assertion: it now fences
  // AGAINST a well-meaning re-add. If a real remote client ever needs it, recover the source
  // from git history and rebuild WITH authentication (do not just un-delete this surface).
  test('package.json does NOT expose the unauthenticated HTTP transport', () => {
    const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

    expect(packageJson.bin).not.toHaveProperty('cmos-mcp-http');
    expect(packageJson.scripts ?? {}).not.toHaveProperty('start:http');
    expect(packageJson.exports ?? {}).not.toHaveProperty('./http-server');

    // No bin/export/script value may point at the deleted http-server artifact.
    const referencesHttpServer = [
      ...Object.values(packageJson.bin ?? {}),
      ...Object.values(packageJson.scripts ?? {}),
      ...Object.values(packageJson.exports ?? {}).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : Object.values(entry)
      ),
    ].some((value) => typeof value === 'string' && value.includes('http-server'));
    expect(referencesHttpServer).toBe(false);

    // The stdio bin — the product — is untouched.
    expect(packageJson.bin).toMatchObject({ 'cmos-mcp': './dist/index.js' });
  });

  test('the http-server source and transport docs are deleted from the repo', () => {
    for (const relativePath of [
      'src/http-server.ts',
      'HTTP_TRANSPORT.md',
      'README_HTTP.md',
      'ecosystem.config.js',
    ]) {
      expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  test('.npmignore excludes private workspace artifacts but not the shipped seed', () => {
    const npmIgnoreLines = readTextFile('.npmignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(npmIgnoreLines).toEqual(
      expect.arrayContaining([
        'cmos/',
        'tests/',
        'tmp/',
        'coverage/',
        '.eslintcache',
        '.github/',
        'scripts/',
      ])
    );
    expect(npmIgnoreLines).not.toContain('cmos-seed/');
  });

  PRIVATE.describe('private-source npm publish workflow', () => {
    test('triggers on version tags and publishes to npm', () => {
      const workflow = fs.readFileSync(PRIVATE.paths.workflow, 'utf8');

      expect(workflow).toMatch(/name:\s+Publish to npm/);
      expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*-\s*'v\*'/m);
      expect(workflow).toMatch(/npm pack --dry-run/);
      // Publishes with --access public (scoped package). Deliberately WITHOUT --provenance:
      // provenance requires a PUBLIC source repo, but this is the private publish source
      // (F2/F4), so `npm publish --provenance` fails with npm E422 (s73 release). The negative
      // guard stops a well-meaning re-add from re-breaking the publish.
      expect(workflow).toMatch(/npm publish --access public/);
      expect(workflow).not.toMatch(/npm publish --provenance/);
      expect(workflow).toMatch(/NODE_AUTH_TOKEN:\s+\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    });
  });
});
