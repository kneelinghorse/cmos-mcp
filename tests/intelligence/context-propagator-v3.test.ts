import {
  MissionHistoryAnalyzer,
  MissionHistoryHighlight,
  MissionTransitionEdge,
} from '../../src/intelligence/mission-history';
import { ContextPropagatorV3 } from '../../src/intelligence/context-propagator-v3';
import { SubMissionResult } from '../../src/intelligence/context-propagator';

class StubMissionHistoryAnalyzer extends MissionHistoryAnalyzer {
  constructor(
    private readonly transitions: MissionTransitionEdge[] = [],
    private readonly highlights: MissionHistoryHighlight[] = []
  ) {
    super({ sessionsPath: '' });
  }

  async deriveTransitions(): Promise<MissionTransitionEdge[]> {
    return this.transitions;
  }

  async collectHighlights(
    missionIds: Iterable<string>,
    limitPerMission = 1
  ): Promise<MissionHistoryHighlight[]> {
    const requested = new Set(missionIds);
    if (requested.size === 0) {
      return [];
    }

    const grouped = new Map<string, MissionHistoryHighlight[]>();
    for (const highlight of this.highlights) {
      if (!requested.has(highlight.missionId)) {
        continue;
      }
      if (!grouped.has(highlight.missionId)) {
        grouped.set(highlight.missionId, []);
      }
      grouped.get(highlight.missionId)!.push(highlight);
    }

    const pruned: MissionHistoryHighlight[] = [];
    for (const items of grouped.values()) {
      pruned.push(...items.slice(0, limitPerMission));
    }

    return pruned;
  }
}

describe('ContextPropagatorV3', () => {
  it('surfaces high-signal chunks using hybrid sparse+dense retrieval', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 2048 }, history);

    const completedResults: SubMissionResult[] = [
      {
        missionId: 'S1',
        input:
          'Investigate hybrid retrieval strategies blending lexical scoring, bm25 weighting, ' +
          'and vector similarity to support context propagation upgrades.',
        output:
          'Implemented sparse keyword matching plus dense embedding retrieval with adaptive chunk windows.',
        status: 'success',
        timestamp: new Date('2025-10-28T10:00:00Z'),
      },
      {
        missionId: 'S2',
        input: 'Document updated propagation spec focusing on summarization improvements.',
        output:
          'Delivered narrative summaries and refined extractive heuristics for short-form missions.',
        status: 'success',
        timestamp: new Date('2025-10-28T12:00:00Z'),
      },
    ];

    const summary = await propagator.propagateContext(
      'Upgrade context propagation with hybrid retrieval augmented generation pipeline.',
      completedResults,
      'B6.3',
      {
        query: 'hybrid retrieval pipeline dense embedding chunking',
        retrievalCount: 3,
      }
    );

    expect(summary.retrievedChunks.length).toBeGreaterThan(0);
    expect(summary.summary).toContain('=== HYBRID RAG CONTEXT ===');
    expect(summary.retrievedChunks[0].missionId).toBe('S1');
    expect(summary.retrievalStats.totalChunks).toBeGreaterThan(0);
    expect(summary.retrievalStats.topK).toBeGreaterThan(0);
  });

  it('derives default query from mission chain when none provided', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Mission objective focuses on adaptive retrieval refinement and evaluation.',
      [
        {
          missionId: 'S10',
          input: 'Research adaptive retrieval evaluation metrics across pipelines.',
          output: 'Outlined success metrics and evaluation signals.',
          status: 'success',
          timestamp: new Date('2025-10-28T11:00:00Z'),
        },
        {
          missionId: 'S11',
          input: 'Finalize orchestration spec for hybrid retrieval propagation.',
          output: 'Produced finalized orchestration spec with scoring guide.',
          status: 'success',
          timestamp: new Date('2025-10-28T11:30:00Z'),
        },
      ],
      'B6.3'
    );

    expect(summary.retrievedChunks.length).toBeGreaterThan(0);
    expect(summary.summary).toContain('=== HYBRID RAG CONTEXT ===');
    expect(summary.retrievedChunks.some((chunk) => chunk.missionId === 'S11')).toBe(true);
  });

  it('falls back gracefully when no prior results are available', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Establish baseline mission without historical context.',
      [],
      'B6.3'
    );

    expect(summary.retrievedChunks).toHaveLength(0);
    expect(summary.summary).not.toContain('HYBRID RAG CONTEXT');
    expect(summary.retrievalStats.totalChunks).toBe(0);
    expect(summary.retrievalStats.topK).toBe(0);
  });

  it('skips retrieval when the query collapses to whitespace only', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Mission text supplying default query seed.',
      [
        {
          missionId: 'S3',
          input: 'Non-empty content that will be ignored due to empty query.',
          output: 'Provides at least one retrievable chunk.',
          status: 'success',
          timestamp: new Date('2025-10-28T13:00:00Z'),
        },
      ],
      'B6.3',
      {
        query: '   ',
        retrievalCount: 2,
      }
    );

    expect(summary.retrievedChunks).toHaveLength(0);
    expect(summary.retrievalStats.totalChunks).toBe(0);
    expect(summary.summary).not.toContain('HYBRID RAG CONTEXT');
  });

  it('normalizes weights and handles stopword-only queries', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Propagation research mission objective grounding retrieval evaluation.',
      [
        {
          missionId: 'S4',
          input: 'Design adaptive chunking with overlap and sparse keywords.',
          output: 'Chunking strategy finalized with heuristics for retrieval.',
          status: 'success',
          timestamp: new Date('2025-10-28T14:00:00Z'),
        },
      ],
      'B6.3',
      {
        query: 'the and for with',
        sparseWeight: -2,
        denseWeight: 3,
      }
    );

    expect(summary.retrievedChunks).toHaveLength(0);
    expect(summary.summary).not.toContain('HYBRID RAG CONTEXT');
    expect(summary.retrievalStats.totalChunks).toBeGreaterThan(0);
    expect(summary.retrievalStats.topK).toBe(0);
    expect(summary.retrievalStats.sparseWeight).toBeCloseTo(0.5);
    expect(summary.retrievalStats.denseWeight).toBeCloseTo(1);
  });

  it('builds corpus even when inputs or outputs are missing on individual results', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Bridge sparse and dense retrieval quality checks.',
      [
        {
          missionId: 'S5',
          input: '',
          output: 'Vector scoring overview with fallback heuristics and normalization.',
          status: 'success',
          timestamp: new Date('2025-10-28T15:00:00Z'),
        },
        {
          missionId: 'S6',
          input: 'Hybrid pipeline evaluation metrics and regression coverage outline.',
          output: '',
          status: 'success',
          timestamp: new Date('2025-10-28T16:00:00Z'),
        },
      ],
      'B6.3',
      {
        query: 'pipeline evaluation heuristics',
        retrievalCount: 2,
      }
    );

    expect(summary.retrievedChunks.length).toBeGreaterThan(0);
    expect(summary.retrievedChunks.some((chunk) => chunk.missionId === 'S5')).toBe(true);
    expect(summary.retrievedChunks.some((chunk) => chunk.missionId === 'S6')).toBe(true);
    expect(summary.summary).toContain('=== HYBRID RAG CONTEXT ===');
  });

  it('removes zero-score chunks after ranking to keep context high-signal', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Ensure zero-signal chunks do not pollute propagated summaries.',
      [
        {
          missionId: 'S7',
          input: 'Retrieval scoring matrix and pipeline orchestration refinements.',
          output: '',
          status: 'success',
          timestamp: new Date('2025-10-28T17:00:00Z'),
        },
        {
          missionId: 'S8',
          input: 'Quantum oscillations accelerate neutrino flux calculations.',
          output: 'Astrophysics excursion unrelated to cosmic diagnostics.',
          status: 'success',
          timestamp: new Date('2025-10-28T18:00:00Z'),
        },
      ],
      'B6.3',
      {
        query: 'retrieval scoring pipeline orchestration',
        retrievalCount: 2,
      }
    );

    expect(summary.retrievedChunks.length).toBe(1);
    expect(summary.retrievedChunks[0].missionId).toBe('S7');
  });

  it('returns empty retrieval when tokenization strips all corpus content', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const propagator = new ContextPropagatorV3({ maxContextTokens: 1024 }, history);

    const summary = await propagator.propagateContext(
      'Ensure fallback path when all content lacks alphanumeric tokens.',
      [
        {
          missionId: 'S9',
          input: '### ### ###',
          output: '*** *** ***',
          status: 'success',
          timestamp: new Date('2025-10-28T19:00:00Z'),
        },
      ],
      'B6.3',
      {
        query: 'tokenization',
      }
    );

    expect(summary.retrievedChunks).toHaveLength(0);
    expect(summary.retrievalStats.totalChunks).toBe(0);
  });
});
