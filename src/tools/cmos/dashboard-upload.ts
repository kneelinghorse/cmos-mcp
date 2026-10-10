// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared lease and consistent SQLite snapshot for explicit and automatic dashboard uploads.
// ABOUTME: Reads store identity without mutation and retains pending work across failure or process exit.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { UploadOutcome } from '../../intelligence/project-upload-state';
import { isSameDirectory } from '../../intelligence/resolution-policy';

export interface UploadProject {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly name: string;
  readonly registered: boolean;
}

export function uploadLog(message: string): void {
  process.stderr.write(`[CHECKPOINT] ${message}\n`);
}

/** Missing metadata means an old/foreign store; query failures remain visible to the caller. */
export function readUploadProject(projectRoot: string): UploadProject | null {
  const root = path.resolve(projectRoot);
  const dbPath = path.join(root, 'cmos', 'db', 'cmos.sqlite');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get())
      return null;
    const values = new Map(
      (
        db
          .prepare(
            "SELECT key,value FROM metadata WHERE key IN ('project_id','project_name','dashboard_registered')"
          )
          .all() as Array<{ key: string; value: string | null }>
      ).map((r) => [r.key, r.value])
    );
    const projectId = values.get('project_id');
    if (!projectId) return null;
    return {
      projectId,
      projectRoot: root,
      dbPath,
      name: values.get('project_name') ?? projectId,
      registered: values.get('dashboard_registered') === 'true',
    };
  } finally {
    db.close();
  }
}

export async function withUploadSnapshot<T>(
  dbPath: string,
  send: (file: string) => Promise<T>
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-dashboard-upload-'));
  const file = path.join(directory, 'cmos.sqlite');
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    await db.backup(file);
    db.close();
    db = undefined;
    return await send(file);
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Both entry points take this lease before registration/reconciliation, snapshot or network work. */
export async function withUploadLease(
  projectRoot: string,
  explicit: boolean,
  send: () => Promise<UploadOutcome>
): Promise<void> {
  const project = readUploadProject(projectRoot);
  if (!project || (!explicit && !project.registered)) return;
  const registry = await ProjectGraphRegistry.create();
  let entry = registry.get(project.projectId);
  if (!entry && explicit)
    entry = registry.register({
      project_id: project.projectId,
      store_path: project.projectRoot,
      name: project.name,
    });
  if (!entry || !isSameDirectory(entry.store_path, project.projectRoot))
    throw new Error('Upload project identity does not match its registered store path.');
  if (explicit && !registry.markUploadOwed(project.projectId))
    throw new Error('Could not mark the explicit upload owed.');
  const lease = registry.claimUpload(project.projectId, explicit);
  if (!lease) return;
  let lost = false;
  const keepAlive = setInterval(() => {
    try {
      if (!registry.renewUploadLease(project.projectId, lease.token)) {
        lost = true;
        uploadLog(
          `Upload lease lost for ${project.projectId}; completion cannot clear pending work.`
        );
      }
    } catch (error) {
      lost = true;
      uploadLog(
        `Upload lease renewal failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, 60_000);
  keepAlive.unref();
  let outcome: UploadOutcome;
  try {
    outcome = await send();
  } catch (error) {
    outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearInterval(keepAlive);
  }
  if (lost || !registry.finishUpload(project.projectId, lease, outcome)) {
    uploadLog(
      `Upload result could not be committed for ${project.projectId}; its pending mark remains.`
    );
  }
  if (!outcome.success)
    uploadLog(`Upload failed for ${project.projectId}: ${outcome.error ?? 'unknown'}`);
}
