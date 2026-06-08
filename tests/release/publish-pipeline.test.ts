import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
};

const projectRoot = path.resolve(__dirname, '..', '..');

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
      'cmos-mcp-http': './dist/http-server.js',
    });

    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
      './http-server': {
        types: './dist/http-server.d.ts',
        require: './dist/http-server.js',
        default: './dist/http-server.js',
      },
      './package.json': './package.json',
    });
  });

  test('.npmignore excludes local workspace and development artifacts', () => {
    const npmIgnoreLines = readTextFile('.npmignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(npmIgnoreLines).toEqual(
      expect.arrayContaining(['cmos/', 'cmos-seed/', 'tests/', 'tmp/', 'coverage/', '.eslintcache'])
    );
  });

  test('publish workflow triggers on version tags and publishes to npm', () => {
    const workflow = readTextFile('.github/workflows/publish.yml');

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
