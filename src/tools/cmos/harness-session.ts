// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — the harness session link: the hashed harness session id, and the runtime files under
// ABOUTME: the config directory that tie a harness process to it. Light on purpose: hook verbs load it.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { findEnclosingStore } from '../../intelligence/resolution-policy';

/**
 * WHY A FILE, NOT THE ENVIRONMENT (decision #1189; cmos/research/2026-10-s93-probes/, the /clear
 * probe). Claude Code starts its MCP servers once per harness process and keeps them across
 * `/clear`, and the CLAUDE_CODE_SESSION_ID in a server's environment is the session id that was
 * current when the server was spawned, so it goes stale at the next `/clear`. Hooks see the current
 * id on stdin, and CLAUDE_PID, the harness process. So SessionStart writes a link for the harness
 * process, and the server reads it on each write.
 *
 * WHAT A LINK HOLDS. `<configDir>/runtime/harness/<CLAUDE_PID>.json`, replaced whole by every
 * SessionStart: the hashed current session id; every session hash this harness process has had
 * (`seen`, oldest first and bounded; a `startup` begins a new list); and the folder the
 * conversation works in. SessionEnd writes `<CLAUDE_PID>.ended` with the hash it ended, so a link is
 * never read, changed and written back (the m01 confirming critic measured that race).
 *
 * HOW A SERVER FINDS ITS LINK (the m01 build critics, B2 and NB1). A server is not always the
 * harness's direct child (`npx cmos-mcp` puts `npm exec` between them; a Windows `.cmd` shim puts
 * `cmd.exe` there), and its CLAUDE_CODE_SESSION_ID may be the harness's first session id or a
 * later one, if it was respawned after a `/clear`.
 *   1. Its parent's link, when that link has seen its id, or was written no more than a minute
 *      before the server started (hooks installed mid-conversation). An older one that has not seen
 *      it belongs to a dead harness whose pid a launcher reused.
 *   2. Otherwise the one link that has seen its id. Two can, when `claude --resume` reopens a session
 *      in a new process while the first is alive: then the one whose harness is an ancestor of this
 *      process, and with neither, none.
 * A server with no link keeps its pid key, as in 3.2.0.
 *
 * WHERE THE KEY APPLIES (the m01 confirming critic, NB2). Only in the store enclosing the link's
 * folder. SessionEnd closes the conversation's sessions in that store, so a session keyed by the
 * conversation anywhere else would never be closed; writes to another project keep the pid key, as
 * in 3.2.0.
 *
 * NO RAW HARNESS ID IS STORED. Owner keys, runtime files and anything m02, m04 and m06 key by the
 * session go through {@link harnessSessionHash}. The link holds the conversation's folder path.
 */

/** The user-level config directory, as the registry and credential store resolve it. */
export function cmosConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CMOS_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'cmos-mcp');
}

/** `<configDir>/runtime`, where per-machine state that is never committed or uploaded lives. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cmosConfigDir(env), 'runtime');
}

/**
 * The one hash of a harness session id: 16 hex characters of its SHA-256. Shared by every keyed
 * use (the owner key, runtime files, telemetry, drafts) so they agree on a session without storing
 * the id itself.
 */
export function harnessSessionHash(rawSessionId: string): string {
  return createHash('sha256').update(rawSessionId.trim()).digest('hex').slice(0, 16);
}

/** How many of a harness process's session hashes its link remembers. */
const SEEN_LIMIT = 64;

/** What SessionStart records for a harness process. */
export interface HarnessLink {
  /** {@link harnessSessionHash} of the harness's current session id. */
  readonly hash: string;
  /** Every session hash this harness process has had, oldest first; the last is `hash`. */
  readonly seen: readonly string[];
  /** The folder the conversation works in, as the hook resolved it; null when it resolved none. */
  readonly projectDir: string | null;
  /** SessionStart's `source` (startup, resume, clear, compact), when the hook carried one. */
  readonly source: string | null;
  /** ISO time the link was written. */
  readonly writtenAt: string;
}

/** The runtime file linking the harness process `harnessPid` to its current session. */
export function harnessLinkPath(harnessPid: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(env), 'harness', `${harnessPid}.json`);
}

/** The file SessionEnd writes: the hash of the session that ended in `harnessPid`. */
function harnessEndedPath(harnessPid: number, env: NodeJS.ProcessEnv): string {
  return path.join(runtimeDir(env), 'harness', `${harnessPid}.ended`);
}

const HASH_PATTERN = /^[0-9a-f]{16}$/;

/** Read a harness link, or null when there is none or it cannot be read. Never throws. */
export function readHarnessLink(
  harnessPid: number,
  env: NodeJS.ProcessEnv = process.env
): HarnessLink | null {
  return readLinkFile(harnessLinkPath(harnessPid, env));
}

function readLinkFile(file: string): HarnessLink | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.hash !== 'string' || !HASH_PATTERN.test(parsed.hash)) return null;
    const seen = Array.isArray(parsed.seen)
      ? parsed.seen.filter((h): h is string => typeof h === 'string' && HASH_PATTERN.test(h))
      : [];
    return {
      hash: parsed.hash,
      seen: seen.includes(parsed.hash) ? seen : [...seen, parsed.hash],
      projectDir: typeof parsed.projectDir === 'string' ? parsed.projectDir : null,
      source: typeof parsed.source === 'string' ? parsed.source : null,
      writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : '',
    };
  } catch {
    return null;
  }
}

/** Write a file atomically (temp file, then rename), so a reader never sees half of it. */
function writeAtomically(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, target);
}

/** Write a harness link atomically. */
export function writeHarnessLink(
  harnessPid: number,
  link: HarnessLink,
  env: NodeJS.ProcessEnv = process.env
): void {
  writeAtomically(harnessLinkPath(harnessPid, env), JSON.stringify(link));
}

/**
 * Whether the session a link names has ended: SessionEnd recorded its hash. A SessionEnd that runs
 * after the next SessionStart (they race on `/clear`) records the old hash, which no longer
 * matches the link.
 */
export function harnessLinkEnded(
  harnessPid: number,
  link: HarnessLink,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    return fs.readFileSync(harnessEndedPath(harnessPid, env), 'utf8').trim() === link.hash;
  } catch {
    return false;
  }
}

/**
 * Remove the links, end marks and half-written temp files whose harness process is gone: a harness
 * that crashed never ran SessionEnd, and a link outliving its process could be read by a server
 * whose parent later reuses that pid. Session start runs this before writing its own link. A
 * process that exists under another user (EPERM) is alive and keeps its files. Never throws;
 * returns how many files it removed.
 */
export function pruneDeadHarnessLinks(env: NodeJS.ProcessEnv = process.env): number {
  const dir = path.join(runtimeDir(env), 'harness');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^(\d+)\.(?:json|ended)(?:\.(\d+)\.tmp)?$/.exec(name);
    if (!match) continue;
    // A link belongs to its harness; a temp file to the hook process that was writing it.
    const pid = Number(match[2] ?? match[1]);
    if (isProcessAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The harness process a hook runs under (Claude Code's CLAUDE_PID), or null outside one. */
export function harnessPid(env: NodeJS.ProcessEnv): number | null {
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/**
 * SessionStart (every source: a `/clear` or a resume starts a new session in the same process):
 * point the harness process's link at this session and add it to the sessions the process has
 * had. A `startup` is a new harness process, so its list starts over: an older link under the same
 * pid is a dead harness's. Without CLAUDE_PID there is no server to tell, so nothing is written.
 */
export function linkHarness(
  rawSessionId: string,
  source: string | undefined,
  projectDir: string | null,
  env: NodeJS.ProcessEnv = process.env
): void {
  const pid = harnessPid(env);
  if (pid === null) return;
  pruneDeadHarnessLinks(env);
  const hash = harnessSessionHash(rawSessionId);
  const previous = source === 'startup' ? null : readHarnessLink(pid, env);
  const seen = [...(previous?.seen ?? []).filter((seen) => seen !== hash), hash];
  writeHarnessLink(
    pid,
    {
      hash,
      // Past the limit the oldest go, except the first: the id a server spawned at startup carries.
      seen: seen.length <= SEEN_LIMIT ? seen : [seen[0], ...seen.slice(-(SEEN_LIMIT - 1))],
      projectDir: projectDir === null ? null : path.resolve(projectDir),
      source: source ?? null,
      writtenAt: new Date().toISOString(),
    },
    env
  );
  // Re-entering a session that ended in this process (an in-process /resume back to it) clears its
  // end mark; a mark naming another session is left alone.
  const ended = harnessEndedPath(pid, env);
  try {
    if (fs.readFileSync(ended, 'utf8').trim() === hash) fs.unlinkSync(ended);
  } catch {
    // No mark.
  }
}

/** SessionEnd: record that this session ended. The link stays for the next SessionStart. */
export function unlinkHarness(rawSessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  const pid = harnessPid(env);
  if (pid === null) return;
  try {
    writeAtomically(harnessEndedPath(pid, env), harnessSessionHash(rawSessionId));
  } catch {
    // The harness is ending; an unmarked link is pruned once its process is gone.
  }
}

/** How far a link may predate a server with no session id (a hook and a server spawned together). */
const LINK_FRESH_MS = 60_000;
const PROCESS_STARTED_MS = performance.timeOrigin;

let parentPidOverride: number | null = null;
let ancestorsOverride: readonly number[] | null = null;
/** The link file this process matched by its session id, so a write reads one file, not the folder. */
let matchedLinkFile: string | null = null;
let ancestorCache: readonly number[] | null = null;

/** Test seam: act as a server whose parent is `pid` (null restores process.ppid). */
export function setParentPidForTesting(pid: number | null): void {
  parentPidOverride = pid;
  matchedLinkFile = null;
  ancestorCache = null;
}

/** Test seam: act as a server with these ancestor pids, nearest first (null: read them). */
export function setAncestorsForTesting(pids: readonly number[] | null): void {
  ancestorsOverride = pids;
  matchedLinkFile = null;
  ancestorCache = null;
}

/** The harness session this process writes into, and the folder its key applies in. */
export interface LinkedHarness {
  readonly hash: string;
  readonly projectDir: string | null;
}

/**
 * The harness session this process writes into, if a hook linked one (see the module docblock), or
 * null. An ended session counts as none. The link is read on every call (only which file held it is
 * remembered), so a `/clear` reaches the next write.
 */
export function linkedHarness(env: NodeJS.ProcessEnv = process.env): LinkedHarness | null {
  const startId = env.CLAUDE_CODE_SESSION_ID?.trim();
  const mine = startId ? harnessSessionHash(startId) : null;

  const parentPid = parentPidOverride ?? process.ppid;
  const direct = readHarnessLink(parentPid, env);
  // A parent link that has not seen this server's id is taken only if written since the server
  // started (hooks installed mid-conversation); a server with no id allows the minute a hook and a
  // server spawned together can differ by. Anything older is a dead harness's.
  if (
    direct &&
    ((mine !== null && direct.seen.includes(mine)) ||
      writtenSinceStart(harnessLinkPath(parentPid, env), mine === null ? LINK_FRESH_MS : 0))
  ) {
    return current(parentPid, direct, env);
  }
  if (mine === null) return null;
  const match = linkThatHasSeen(mine, env);
  return match ? current(match.pid, match.link, env) : null;
}

function current(pid: number, link: HarnessLink, env: NodeJS.ProcessEnv): LinkedHarness | null {
  return harnessLinkEnded(pid, link, env) ? null : { hash: link.hash, projectDir: link.projectDir };
}

/** Whether a link file was written no more than `slackMs` before this process started. */
function writtenSinceStart(file: string, slackMs: number): boolean {
  try {
    return fs.statSync(file).mtimeMs >= PROCESS_STARTED_MS - slackMs;
  } catch {
    return false;
  }
}

/** The one link that has seen `mine`, or among several, the one whose harness is an ancestor. */
function linkThatHasSeen(
  mine: string,
  env: NodeJS.ProcessEnv
): { pid: number; link: HarnessLink } | null {
  if (matchedLinkFile) {
    const cached = readLinkFile(matchedLinkFile);
    if (cached?.seen.includes(mine)) {
      return { pid: Number(path.basename(matchedLinkFile, '.json')), link: cached };
    }
    matchedLinkFile = null;
  }
  const dir = path.join(runtimeDir(env), 'harness');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const matches: Array<{ pid: number; file: string; link: HarnessLink }> = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    const link = readLinkFile(file);
    if (link?.seen.includes(mine)) matches.push({ pid: Number(name.slice(0, -5)), file, link });
  }
  let chosen = matches.length === 1 ? matches[0] : undefined;
  if (matches.length > 1) {
    // The nearest ancestor: a harness run inside another (a `--resume` under it) is its own.
    for (const pid of ancestorPids()) {
      chosen = matches.find((match) => match.pid === pid);
      if (chosen) break;
    }
  }
  if (!chosen) return null;
  matchedLinkFile = chosen.file;
  return { pid: chosen.pid, link: chosen.link };
}

/**
 * This process's ancestor pids, nearest first, read once: /proc on Linux, one `ps` elsewhere on
 * POSIX, none on Windows (where a tie between two harnesses then leaves the server its pid key).
 */
function ancestorPids(): readonly number[] {
  if (ancestorsOverride) return ancestorsOverride;
  if (ancestorCache) return ancestorCache;
  const parentOf = processParents();
  const chain: number[] = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 32 && pid > 1 && !chain.includes(pid); depth += 1) {
    chain.push(pid);
    pid = parentOf(pid) ?? 0;
  }
  ancestorCache = chain;
  return chain;
}

function processParents(): (pid: number) => number | null {
  if (process.platform === 'linux') {
    return (pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // "pid (comm) state ppid …": comm may hold spaces and parentheses, so read past the last ')'.
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        return Number.isInteger(ppid) ? ppid : null;
      } catch {
        return null;
      }
    };
  }
  if (process.platform === 'win32') return () => null;
  try {
    const parents = new Map<number, number>();
    const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of table.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid);
    }
    return (pid) => parents.get(pid) ?? null;
  } catch {
    return () => null;
  }
}

/**
 * Whether a link's key applies to the store at `dbPath`: only the store enclosing the link's folder
 * (see WHERE THE KEY APPLIES). Compared by real path, so a symlinked spelling is the same store.
 */
export function harnessKeyAppliesTo(linked: LinkedHarness, dbPath: string): boolean {
  if (linked.projectDir === null) return false;
  const store = findEnclosingStore(linked.projectDir);
  if (!store) return false;
  return realPath(path.join(store.root, 'cmos', 'db', 'cmos.sqlite')) === realPath(dbPath);
}

/** `<configDir>/runtime/declined.json`: repositories whose user declined CMOS (the init offer). */
export function declinedPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(env), 'declined.json');
}

/** The repositories (by real path) whose init offer was declined. Never throws. */
export function readDeclined(env: NodeJS.ProcessEnv = process.env): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(declinedPath(env), 'utf8')) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
    );
  } catch {
    return new Set();
  }
}

/** Record or clear a decline for one repository. */
export function setDeclined(
  repoRoot: string,
  declined: boolean,
  env: NodeJS.ProcessEnv = process.env
): void {
  const all = readDeclined(env);
  const key = realPath(repoRoot);
  if (declined) all.add(key);
  else all.delete(key);
  const target = declinedPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify([...all].sort(), null, 2));
  fs.renameSync(temp, target);
}

/** Whether the init offer for `repoRoot` was declined. */
export function isDeclined(repoRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readDeclined(env).has(realPath(repoRoot));
}

/**
 * The path as the filesystem stores it: links resolved, and the letter case on disk (the native
 * call; JS realpath keeps the case as typed, so on macOS one folder could compare unequal to itself).
 */
function realPath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}
