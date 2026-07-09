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
});
