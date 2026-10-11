// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Elects one installer using complete owner records and exclusive filesystem links.
// ABOUTME: Dead-owner recovery is token-scoped so competing or crashed reclaimers cannot steal live ownership.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson } from './install-state.mjs';

function ownerState(record) {
  if (
    !record ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.token !== 'string' ||
    !/^[\da-f-]{36}$/.test(record.token)
  )
    return 'unknown';
  try {
    process.kill(record.pid, 0);
    return 'alive';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function exclusiveLink(source, target) {
  try {
    fs.linkSync(source, target);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function acquireLock(ctx, { afterRecoveryClaim = () => {} } = {}) {
  fs.mkdirSync(ctx.dataRoot, { recursive: true });
  const token = randomUUID();
  const lockPath = ctx.installRoot + '.lock';
  const ownerFile = `${lockPath}.owner-${token}`;
  // O_EXCL creates the owner record; link is the exclusive claim. Publishing a fully written
  // inode eliminates the open(lock, 'wx')/write crash window that leaves an unknowable owner.
  const fd = fs.openSync(ownerFile, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let acquired = false;
  try {
    acquired = exclusiveLink(ownerFile, lockPath);
    if (acquired) return { path: lockPath, ownerFile, token };
    const original = readJson(lockPath);
    let previous = original;
    // Each failed reclaimer owns its own successor claim. Retained claims prevent two live
    // reclaimers from forking the chain. PID reuse conservatively blocks rather than steals.
    for (let depth = 0; depth < 32; depth += 1) {
      const state = ownerState(previous);
      if (state !== 'dead') {
        if (state === 'unknown')
          process.stderr.write('CMOS installer: unknown lock owner; installation deferred.\n');
        return undefined;
      }
      const claimPath = `${lockPath}.recover-${previous.token}`;
      if (!exclusiveLink(ownerFile, claimPath)) {
        previous = readJson(claimPath);
        continue;
      }
      afterRecoveryClaim();
      if (readJson(lockPath)?.token !== original.token) return undefined;
      // Only this elected live reclaimer can remove original. A new lock cannot be acquired
      // before this unlink, and we never unlink again if another worker wins the subsequent link.
      fs.unlinkSync(lockPath);
      acquired = exclusiveLink(ownerFile, lockPath);
      return acquired ? { path: lockPath, ownerFile, token } : undefined;
    }
    process.stderr.write('CMOS installer: recovery chain limit reached; installation deferred.\n');
    return undefined;
  } finally {
    if (!acquired) fs.rmSync(ownerFile, { force: true });
  }
}

export function ownsLock(lock) {
  return readJson(lock.path)?.token === lock.token;
}

export function releaseLock(lock) {
  if (!ownsLock(lock)) return;
  fs.unlinkSync(lock.path);
  fs.rmSync(lock.ownerFile, { force: true });
}
