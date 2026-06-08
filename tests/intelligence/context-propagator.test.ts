import { ContextPropagator, SubMissionResult } from '../../src/intelligence/context-propagator';
import { ContextPropagatorV2 } from '../../src/intelligence/context-propagator-v2';

const buildResult = (missionId: string, size = 10): SubMissionResult => ({
  missionId,
  input: 'I'.repeat(size),
  output: 'O'.repeat(size),
  status: 'success',
  timestamp: new Date('2025-10-29T00:00:00Z'),
});

describe('ContextPropagator', () => {
  it('selects propagation strategies based on chain length', async () => {
    const propagator = new ContextPropagator({ maxContextTokens: 200 });

    const fullSummary = await propagator.propagateContext(
      'Mission Alpha',
      [buildResult('S1')],
      'S1'
    );
    expect(fullSummary.strategy).toBe('full');

    const extractiveSummary = await propagator.propagateContext(
      'Mission Beta',
      [buildResult('E1'), buildResult('E2'), buildResult('E3')],
      'E3'
    );
    expect(extractiveSummary.strategy).toBe('extractive');

    const abstractiveSummary = await propagator.propagateContext(
      'Mission Gamma',
      [
        buildResult('A1'),
        buildResult('A2'),
        buildResult('A3'),
        buildResult('A4'),
        buildResult('A5'),
      ],
      'A5'
    );
    expect(abstractiveSummary.strategy).toBe('abstractive');

    const mapReduceSummary = await propagator.propagateContext(
      'Mission Delta',
      [
        buildResult('M1', 400),
        buildResult('M2', 400),
        buildResult('M3', 400),
        buildResult('M4', 400),
        buildResult('M5', 400),
        buildResult('M6', 400),
        buildResult('M7', 400),
      ],
      'M7'
    );
    expect(mapReduceSummary.strategy).toBe('map-reduce');
    expect(mapReduceSummary.completedSteps).toHaveLength(7);
  });
});

describe('ContextPropagatorV2', () => {
  it('optionally enriches propagated context with mission highlights', async () => {
    const historyAnalyzer = {
      collectHighlights: jest.fn(async () => [
        { missionId: 'B6.2', ts: '2025-10-29T01:00:00Z', summary: 'Lifecycle analyzer shipped' },
      ]),
    };

    const propagator = new ContextPropagatorV2({ maxContextTokens: 200 }, historyAnalyzer as never);

    const results = [buildResult('H1'), buildResult('H2')];
    const enriched = await propagator.propagateContext('Mission Highlights', results, 'H2', {
      includeHistory: true,
      relatedMissionIds: ['B6.2'],
      historyLimitPerMission: 1,
    });

    expect(enriched.historyHighlights).toHaveLength(1);
    expect(enriched.summary).toContain('Mission Highlights');

    const summaryOnly = await propagator.propagateContext('Mission No History', results, 'H2', {
      includeHistory: false,
    });
    expect(summaryOnly.historyHighlights).toHaveLength(0);
  });
});
