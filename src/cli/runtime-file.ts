// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps hook runtime databases and lifecycle files outside project trees and linked files.
// ABOUTME: Checks the destination before directory creation and again before opening a runtime file.

import * as fs from 'fs';
import * as path from 'path';
import { safeDestination, type TelemetryTarget } from '../tools/cmos/local-telemetry';

export function requireSafeRuntime(file: string, target?: TelemetryTarget): void {
  for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    if (!safeDestination(name, target)) throw new Error('unsafe hook runtime destination');
    try {
      const stat = fs.lstatSync(name);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('linked hook runtime file is unsafe');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function prepareRuntimeFile(file: string, target?: TelemetryTarget): void {
  requireSafeRuntime(file, target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  requireSafeRuntime(file, target);
}
