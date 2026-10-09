// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies the lifetime of the harness process rather than trusting a reusable PID.
// ABOUTME: Missing or unsupported process identity deliberately disables cross-source election.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { harnessPid } from '../tools/cmos/harness-session';

/** Linux stat comm may contain spaces and parentheses; starttime is field 22 after the final ')'. */
export function linuxStartTime(stat: string, pid: number): string | null {
  if (!stat.startsWith(`${pid} (`)) return null;
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
}

/** No PID-only or current-process fallback: an unverified lifetime has no election guarantee. */
export function harnessProcessEpoch(
  env: NodeJS.ProcessEnv,
  deadlineAtMs = Infinity
): string | null {
  const pid = harnessPid(env);
  if (pid === null || Date.now() >= deadlineAtMs) return null;
  try {
    if (process.platform === 'linux') {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const start = linuxStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
      return /^[a-f\d-]{36}$/i.test(boot) && start ? `linux:${boot}:${pid}:${start}` : null;
    }
    if (process.platform === 'darwin') {
      const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: Math.max(1, Math.min(100, deadlineAtMs - Date.now())),
        maxBuffer: 1024,
        env: { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
        start
      )
        ? `darwin:${pid}:${start}`
        : null;
    }
  } catch {
    // A gone process, restricted procfs, timeout or malformed ps output cannot prove an epoch.
  }
  return null;
}
