import { describe, expect, it, jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { AgenticObservability } from '../../src/intelligence/agentic-observability';
import * as telemetry from '../../src/intelligence/telemetry';
import * as workspaceIo from '../../src/utils/workspace-io';

describe('AgenticObservability edge cases', () => {
  it('skips logging when logPath is null', async () => {
    const observability = new AgenticObservability({ logPath: null });

    await observability.recordEvent({
      missionId: 'M-1',
      category: 'mission',
      type: 'start',
    });
  });

  it('emits telemetry warning when writes fail', async () => {
    const resolveSpy = jest
      .spyOn(workspaceIo, 'resolveWorkspacePath')
      .mockRejectedValue(new Error('denied'));
    const warnSpy = jest
      .spyOn(telemetry, 'emitTelemetryWarning')
      .mockImplementation(() => undefined as any);

    const observability = new AgenticObservability({
      logPath: path.join(os.tmpdir(), 'agentic-observability', 'events.jsonl'),
      telemetrySource: 'obs-test',
      clock: () => new Date('2025-11-04T00:00:00Z'),
    });

    await observability.recordQualityGate({
      missionId: 'M-2',
      gate: 'coverage',
      status: 'failed',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'obs-test',
      'observability_write_failed',
      expect.objectContaining({
        error: 'denied',
      })
    );

    resolveSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
