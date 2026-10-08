// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Turns a SenderResolutionError into the structured refusal a tool call returns.
// ABOUTME: Moved out of src/index.ts in s92-m01 so the suggestion oracle can drive it in-process.

import path from 'path';

import { CmosDetector } from '../../intelligence/cmos-detector';
import { findEnclosingStore, isSameDirectory, storeAt } from '../../intelligence/resolution-policy';
import type { ResolutionCandidate, SenderResolutionError } from '../../intelligence/sender-context';
import { CmosErrors } from './errors';
import type { CmosToolError } from './types';

function senderEvidenceMessage(error: SenderResolutionError, evidence: string): string {
  return `${error.message} Resolution evidence: ${evidence}`;
}

function isDatabaseFailure(reason: string): boolean {
  return reason === 'failed to open CMOS database' || reason.startsWith('DB read error:');
}

async function classifyConcreteSenderCandidate(
  error: SenderResolutionError,
  candidate: ResolutionCandidate,
  mode: 'read' | 'write'
): Promise<CmosToolError> {
  const reason = candidate.rejectReason ?? `${candidate.source} candidate was not acceptable`;
  const projectRoot = candidate.projectRoot;

  if (isDatabaseFailure(reason) && projectRoot) {
    return CmosErrors.dbConnectionFailed(
      path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite'),
      reason
    );
  }

  if (reason === 'no CMOS database at projectRoot' && projectRoot) {
    // validateProject intentionally records one reason for both absence classes. Re-observe the
    // filesystem without the detector cache so the public error does not guess which one occurred.
    try {
      const detection = await CmosDetector.getInstance().detect(projectRoot, {
        forceRefresh: true,
      });
      // s92-m01: "a store whose database is gone" is judged by the store marker (`cmos/db/`),
      // never by a bare `cmos/` folder — `src/tools/cmos/` is not a project, and offering to
      // init there would nest a project inside the source tree.
      if (storeAt(projectRoot)) {
        return CmosErrors.dbNotFound(
          path.join(detection.cmosDirectory, 'db', 'cmos.sqlite'),
          projectRoot
        );
      }
      // An explicit root inside a project is not a place to init — that would nest a second
      // project inside the first. Name the enclosing project instead.
      const enclosing = candidate.source === 'explicit' ? findEnclosingStore(projectRoot) : null;
      if (enclosing?.hasDatabase && !isSameDirectory(enclosing.root, projectRoot)) {
        return CmosErrors.noProjectForCall({
          situation: 'inside-project',
          dir: projectRoot,
          mode,
          enclosingStore: enclosing.root,
        });
      }
      return CmosErrors.cmosNotDetected(projectRoot);
    } catch (detectionError) {
      const detail =
        detectionError instanceof Error ? detectionError.message : String(detectionError);
      return CmosErrors.senderUnresolvable(
        senderEvidenceMessage(
          error,
          `${reason}; filesystem re-observation failed for '${projectRoot}': ${detail}`
        ),
        error.code
      );
    }
  }

  return CmosErrors.senderUnresolvable(senderEvidenceMessage(error, reason), error.code);
}

/**
 * Classify the resolver's recorded evidence without pre-resolving or repeating identity reads.
 *
 * s92-m01: the resolver now says WHY it refused (`error.outcome`), so the two no-project cases —
 * a working folder that is not a CMOS project, and a server with no project context — map straight
 * to their remedy. A refused SELECTED store (explicit root, MCP root, cwd walk-up, or a default) is
 * the last candidate in the trace and keeps the concrete per-reason classification.
 *
 * @param mode - the call's action mode, so a read is told how to read and a write how to write.
 */
export async function classifySenderResolutionError(
  error: SenderResolutionError,
  mode: 'read' | 'write' = 'write'
): Promise<CmosToolError> {
  if (error.outcome === 'no-project-here' && error.workingDir) {
    return CmosErrors.noProjectForCall({ situation: 'not-a-project', dir: error.workingDir, mode });
  }
  if (error.outcome === 'contextless-no-default' && error.workingDir) {
    return CmosErrors.noProjectForCall({
      situation: 'contextless',
      dir: error.workingDir,
      mode,
      unappliedDefault: error.unappliedDefault
        ? { name: error.unappliedDefault.name, storePath: error.unappliedDefault.storePath }
        : null,
    });
  }

  const selected = [...error.candidates].reverse().find((candidate) => !candidate.accepted);
  if (selected) return classifyConcreteSenderCandidate(error, selected, mode);

  return CmosErrors.senderUnresolvable(
    senderEvidenceMessage(error, 'the resolver supplied no candidate trace'),
    error.code
  );
}
