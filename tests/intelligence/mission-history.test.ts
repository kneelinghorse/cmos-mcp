import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  MissionHistoryAnalyzer,
  MissionHistoryEvent,
} from '../../src/intelligence/mission-history';

const writeHistoryFile = async (events: (MissionHistoryEvent | string)[]): Promise<string> => {
  const filePath = join(
    tmpdir(),
    `mission-history-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`
  );

  const lines = events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)));

  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8');
  return filePath;
};

describe('MissionHistoryAnalyzer', () => {
  let sessionsPath: string;

  afterEach(async () => {
    if (sessionsPath) {
      await fs.unlink(sessionsPath).catch(() => undefined);
      sessionsPath = '';
    }
    jest.restoreAllMocks();
  });

  it('loads events in chronological order while ignoring malformed lines', async () => {
    sessionsPath = await writeHistoryFile([
      { ts: '2025-10-01T10:00:00Z', mission: 'B6.1', action: 'start' },
      'not-json',
      '{"ts":"2025-10-01T10:05:00Z","action":"start"}',
      { ts: '2025-10-01T10:15:00Z', mission: 'B6.1', action: 'complete', next_hint: 'B6.2' },
      { ts: '2025-10-01T10:20:00Z', mission: 'B6.2', action: 'start' },
    ]);

    const analyzer = new MissionHistoryAnalyzer({ sessionsPath });
    const events = await analyzer.loadEvents();

    expect(events).toHaveLength(3);
    expect(events[0].action).toBe('start');
    expect(events[events.length - 1].mission).toBe('B6.2');
  });

  it('derives transitions from next hints and sequential starts', async () => {
    sessionsPath = await writeHistoryFile([
      {
        ts: '2025-10-01T10:00:00Z',
        mission: 'B6.1',
        action: 'complete',
        next_hint: 'Consider B6.2 next',
      },
      { ts: '2025-10-01T10:05:00Z', mission: 'B6.2', action: 'start' },
      {
        ts: '2025-10-01T10:25:00Z',
        mission: 'B6.2',
        action: 'complete',
        next_hint: 'B6.3 follows B6.2',
      },
      { ts: '2025-10-01T10:30:00Z', mission: 'B6.3', action: 'start' },
    ]);

    const analyzer = new MissionHistoryAnalyzer({ sessionsPath });
    const edges = await analyzer.deriveTransitions();

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'B6.2',
          to: 'B6.1',
          source: 'next_hint',
        }),
        expect.objectContaining({
          from: 'B6.3',
          to: 'B6.2',
          source: 'next_hint',
        }),
        expect.objectContaining({
          from: 'B6.2',
          to: 'B6.1',
          source: 'sequence',
        }),
        expect.objectContaining({
          from: 'B6.3',
          to: 'B6.2',
          source: 'sequence',
        }),
      ])
    );
  });

  it('collects recent completion highlights per mission respecting limits', async () => {
    sessionsPath = await writeHistoryFile([
      {
        ts: '2025-10-01T09:00:00Z',
        mission: 'B6.1',
        action: 'complete',
        summary: 'Initial completion',
        agent: 'codex',
      },
      {
        ts: '2025-10-01T10:00:00Z',
        mission: 'B6.1',
        action: 'complete',
        summary: 'Follow-up completion',
        agent: 'codex',
      },
      {
        ts: '2025-10-01T11:00:00Z',
        mission: 'B6.2',
        action: 'complete',
        summary: 'Lifecycle analyzer shipped',
        agent: 'codex',
      },
      { ts: '2025-10-01T11:05:00Z', mission: 'B6.2', action: 'start' },
    ]);

    const analyzer = new MissionHistoryAnalyzer({ sessionsPath });
    const highlights = await analyzer.collectHighlights(['B6.1', 'B6.2'], 1);

    expect(highlights).toHaveLength(2);
    const b61 = highlights.find((highlight) => highlight.missionId === 'B6.1');
    expect(b61?.summary).toBe('Follow-up completion');
    const b62 = highlights.find((highlight) => highlight.missionId === 'B6.2');
    expect(b62?.summary).toBe('Lifecycle analyzer shipped');
  });

  it('returns no highlights when no mission ids are provided', async () => {
    sessionsPath = await writeHistoryFile([
      {
        ts: '2025-10-01T09:00:00Z',
        mission: 'B6.1',
        action: 'complete',
        summary: 'Initial completion',
        agent: 'codex',
      },
    ]);

    const analyzer = new MissionHistoryAnalyzer({ sessionsPath });
    const highlights = await analyzer.collectHighlights([], 2);

    expect(highlights).toHaveLength(0);
  });

  it('uses default sessions path when options are omitted', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValueOnce('');

    const analyzer = new MissionHistoryAnalyzer();
    await analyzer.loadEvents();

    expect(fs.readFile).toHaveBeenCalledWith('SESSIONS.jsonl', 'utf-8');
  });

  it('creates a sessions log when the file is missing', async () => {
    const workspaceTmp = join(process.cwd(), 'tmp');
    await fs.mkdir(workspaceTmp, { recursive: true });
    sessionsPath = join(workspaceTmp, `mission-history-${Date.now()}.jsonl`);
    await fs.rm(sessionsPath, { force: true });

    const analyzer = new MissionHistoryAnalyzer({ sessionsPath });
    const events = await analyzer.loadEvents();

    expect(events).toEqual([]);
    const stats = await fs.stat(sessionsPath);
    expect(stats.isFile()).toBe(true);
  });

  it('skips self-references and duplicate transitions when deriving history edges', async () => {
    sessionsPath = await writeHistoryFile([
      {
        ts: '2025-10-01T08:00:00Z',
        mission: 'B6.4',
        action: 'complete',
        next_hint: 'Stay on B6.4 for validation',
      }, // self-ref should be skipped
      {
        ts: '2025-10-01T08:03:00Z',
        mission: 'B6.4',
        action: 'complete',
        next_hint: 'Focus on documentation updates',
      },
      {
        ts: '2025-10-01T08:05:00Z',
        mission: 'B6.4',
        action: 'complete',
        next_hint: 'Move to B6.5 next',
      },
      {
        ts: '2025-10-01T08:06:00Z',
        mission: 'B6.4',
        action: 'complete',
        next_hint: 'Move to B6.5 next',
      }, // duplicate hint ignored
      { ts: '2025-10-01T08:10:00Z', mission: 'B6.5', action: 'start' }, // sequence edge B6.5 -> B6.4
      {
        ts: '2025-10-01T08:30:00Z',
        mission: 'B6.5',
        action: 'complete',
        next_hint: 'Look at B6.6',
      },
      { ts: '2025-10-01T08:31:00Z', mission: 'B6.5', action: 'start' }, // sequence with same mission should be skipped
      { ts: '2025-10-01T08:40:00Z', mission: 'B6.6', action: 'start' },
      { ts: '2025-10-01T08:45:00Z', mission: 'B6.6', action: 'complete', next_hint: 'B6.7' },
      { ts: '2025-10-01T08:46:00Z', mission: 'B6.7', action: 'start' },
      { ts: '2025-10-01T08:47:00Z', mission: 'B6.7', action: 'complete' },
      { ts: '2025-10-01T08:48:00Z', mission: 'B6.7', action: 'start' }, // same mission start after complete -> skipped
      { ts: '2025-10-01T08:50:00Z', mission: 'B6.8', action: 'complete' },
      { ts: '2025-10-01T08:51:00Z', mission: 'B6.9', action: 'start' },
      { ts: '2025-10-01T08:52:00Z', mission: 'B6.8', action: 'complete' }, // duplicate sequence pair
      { ts: '2025-10-01T08:53:00Z', mission: 'B6.9', action: 'start' },
    ]);

    const analyzer = new MissionHistoryAnalyzer({ sessionsPath });
    const edges = await analyzer.deriveTransitions();

    // We should only see unique edges without self-references or duplicate keys
    const hints = edges.filter((edge) => edge.source === 'next_hint');
    expect(hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'B6.5', to: 'B6.4', source: 'next_hint' }),
        expect.objectContaining({ from: 'B6.6', to: 'B6.5', source: 'next_hint' }),
        expect.objectContaining({ from: 'B6.7', to: 'B6.6', source: 'next_hint' }),
      ])
    );
    expect(hints.filter((edge) => edge.from === 'B6.5' && edge.to === 'B6.4')).toHaveLength(1);
    expect(hints.some((edge) => edge.from === edge.to)).toBe(false);

    const sequences = edges.filter((edge) => edge.source === 'sequence');
    expect(sequences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'B6.5', to: 'B6.4', source: 'sequence' }),
        expect.objectContaining({ from: 'B6.7', to: 'B6.6', source: 'sequence' }),
        expect.objectContaining({ from: 'B6.9', to: 'B6.8', source: 'sequence' }),
      ])
    );
    expect(sequences.filter((edge) => edge.from === 'B6.9' && edge.to === 'B6.8')).toHaveLength(1);
  });
});
