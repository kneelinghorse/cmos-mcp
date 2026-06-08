import { promises as fs } from 'fs';
import { join } from 'path';

import { AgenticObservability } from '../../src/intelligence/agentic-observability';
import {
  TelemetryEvent,
  registerTelemetryHandler,
  setTelemetryLevel,
} from '../../src/intelligence/telemetry';
import { pathExists } from '../../src/utils/fs';

const TEST_TIMEOUT_MS = 15_000; // Headroom for coverage + workspace guard I/O
jest.setTimeout(TEST_TIMEOUT_MS);

const createWorkspaceTempDir = async (): Promise<string> => {
  const workspaceTmp = join(process.cwd(), 'tmp');
  await fs.mkdir(workspaceTmp, { recursive: true });
  return fs.mkdtemp(join(workspaceTmp, 'agentic-observability-'));
};

describe('AgenticObservability', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    registerTelemetryHandler(null);
    setTelemetryLevel('warning');
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it('writes structured events to the configured JSONL log', async () => {
    const baseDir = await createWorkspaceTempDir();
    tempDirs.push(baseDir);
    const logPath = join(baseDir, 'observability.jsonl');
    const clock = () => new Date('2025-11-04T04:05:00Z');

    const observability = new AgenticObservability({ logPath, clock });

    await observability.recordEvent({
      missionId: 'B8.6',
      category: 'mission',
      type: 'mission_started',
      status: 'in_progress',
      data: {
        objective: 'Instrument observability and governance tooling',
      },
    });

    await observability.recordQualityGate({
      missionId: 'B8.6',
      gate: 'mission_completion',
      status: 'passed',
      detail: 'Mission completed cleanly.',
      data: {
        summary: 'All guardrails satisfied',
      },
    });

    const raw = await fs.readFile(logPath, 'utf-8');
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      missionId: 'B8.6',
      category: 'mission',
      type: 'mission_started',
      status: 'in_progress',
    });
    expect(entries[1]).toMatchObject({
      missionId: 'B8.6',
      category: 'quality_gate',
      type: 'mission_completion',
      status: 'passed',
      detail: 'Mission completed cleanly.',
    });
  });

  it('skips logging when the log path is disabled', async () => {
    const baseDir = await createWorkspaceTempDir();
    tempDirs.push(baseDir);
    const logPath = join(baseDir, 'disabled.jsonl');

    const observability = new AgenticObservability({
      logPath: null,
      clock: () => new Date('2025-11-04T04:05:00Z'),
    });

    await observability.recordEvent({
      missionId: 'B8.6',
      category: 'mission',
      type: 'mission_started',
    });

    expect(await pathExists(logPath)).toBe(false);
  });

  it('emits telemetry warnings when writing fails and still attempts remaining entries', async () => {
    const baseDir = await createWorkspaceTempDir();
    tempDirs.push(baseDir);
    const logPath = join(baseDir, 'observability.jsonl');

    const telemetryEvents: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => telemetryEvents.push(event));
    setTelemetryLevel('info');

    const appendFileSpy = jest
      .spyOn(fs, 'appendFile')
      .mockRejectedValueOnce(new Error('disk full'));

    const observability = new AgenticObservability({
      logPath,
      clock: () => new Date('2025-11-04T04:06:00Z'),
      telemetrySource: 'test-observability',
    });

    await observability.recordQualityGates([
      {
        missionId: 'B8.6',
        gate: 'artifacts_verified',
        status: 'passed',
        detail: 'Artifacts validated',
      },
      {
        missionId: 'B8.6',
        gate: 'telemetry_recorded',
        status: 'warning',
        detail: 'Telemetry partially captured',
      },
    ]);

    expect(appendFileSpy.mock.calls).toHaveLength(2);
    expect(telemetryEvents).toContainEqual({
      source: 'test-observability',
      level: 'warning',
      message: 'observability_write_failed',
      context: expect.objectContaining({
        error: 'disk full',
        logPath,
      }),
    });

    appendFileSpy.mockRestore();
  });
});
