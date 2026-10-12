import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Arc C / s78-m02 (FORK-2 = B): the transitive dependency chain
// @xenova/transformers -> onnxruntime-web -> onnx-proto declares protobufjs ^6,
// which carries a CRITICAL advisory cluster (arbitrary code execution, prototype
// pollution, several DoS). We force protobufjs to ^7 via package.json `overrides`,
// which clears the whole critical/high cluster from `npm audit`. An empirical embed
// gate (a real 384-dim vector, byte-identical before/after the pin — see the mission
// verify) proved onnx int64 tensor-dim deserialization survives the 6->7 upgrade.
//
// This guard fences AGAINST a regen/upgrade silently dropping the pin and letting the
// critical chain back in. If protobufjs 7 ever breaks the embed, the remediation is the
// pre-authorized branch-C fallback (documented accepted residual), NOT deleting this pin
// without a replacement mitigation.

type PackageJson = {
  overrides?: Record<string, string>;
};

const projectRoot = path.resolve(__dirname, '..', '..');

describe('dependency security overrides', () => {
  test('protobufjs is pinned to ^7 to clear the critical onnx-proto chain', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    ) as PackageJson;

    const pin = packageJson.overrides?.protobufjs;
    expect(pin).toBeDefined();
    // Accept any ^7 / >=7 style range; reject a re-drop to 6.x.
    const majorMatch = /(\d+)/.exec(pin ?? '');
    expect(majorMatch).not.toBeNull();
    expect(Number(majorMatch?.[1])).toBeGreaterThanOrEqual(7);
  });

  test('the resolved protobufjs in the lockfile is a 7.x version', () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { packages?: Record<string, { version?: string }> };

    const protobufEntries = Object.entries(lock.packages ?? {}).filter(([key]) =>
      /(^|\/)node_modules\/protobufjs$/.test(key)
    );
    expect(protobufEntries.length).toBeGreaterThan(0);
    for (const [, meta] of protobufEntries) {
      expect(meta.version).toBeDefined();
      expect(Number((meta.version ?? '').split('.')[0])).toBeGreaterThanOrEqual(7);
    }
  });

  // s99-m01: the development tree was cleared of four advisories (cmos/research/2026-10-s99-m01).
  // Two have no fixed release (braces, sprintf-js), so the guard is that no path reaches them at
  // all; the other two must resolve at or above their fixed versions. A regenerated lockfile or a
  // dependency bump that brings one back fails here instead of in the next audit.
  test('the development tree stays clear of the advisories s99-m01 cleared', () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { packages?: Record<string, { version?: string }> };
    const versions = (name: string): string[] =>
      Object.entries(lock.packages ?? {})
        .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
        .map(([, meta]) => meta.version ?? '');
    const atLeast = (version: string, floor: string): boolean => {
      const a = version.split('.').map(Number);
      const b = floor.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return true;
    };

    // handlebars, critical (GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f): fixed in 4.7.10.
    expect(versions('handlebars').length).toBeGreaterThan(0);
    for (const v of versions('handlebars')) expect([v, atLeast(v, '4.7.10')]).toEqual([v, true]);
    // braces, high (GHSA-vfj7-8cjw-p6xm), and sprintf-js, moderate (GHSA-hp3w-g68c-fv3c): no fixed
    // release exists, so nothing may depend on them.
    expect(versions('braces')).toEqual([]);
    expect(versions('sprintf-js')).toEqual([]);
    // uuid, moderate (GHSA-w5hq-g745-h8pq): fixed in 11.1.1; jest-cucumber 4.5.0 asks for ^10 and
    // @cucumber/messages 24 for exactly 9.0.1.
    expect(versions('uuid').length).toBeGreaterThan(0);
    for (const v of versions('uuid')) expect([v, atLeast(v, '11.1.1')]).toEqual([v, true]);
  });

  test('the development overrides that clear sprintf-js and uuid stay in package.json', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { overrides?: Record<string, unknown> };
    // load-nyc-config only calls js-yaml.load, which js-yaml 4 keeps; js-yaml 4 drops argparse 1,
    // the only path to sprintf-js.
    expect(packageJson.overrides?.['@istanbuljs/load-nyc-config']).toEqual({ 'js-yaml': '^4.1.0' });
    expect(packageJson.overrides?.uuid).toBe('^11.1.1');
  });
});
