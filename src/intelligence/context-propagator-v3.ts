import { ContextPropagatorConfig, SubMissionResult } from './context-propagator';
import {
  ContextPropagatorV2,
  ContextPropagatorV2Options,
  ContextSummaryV2,
} from './context-propagator-v2';
import { MissionHistoryAnalyzer } from './mission-history';

export interface HybridRetrievalOptions extends ContextPropagatorV2Options {
  query?: string;
  retrievalCount?: number;
  chunkTokens?: number;
  chunkOverlapTokens?: number;
  sparseWeight?: number;
  denseWeight?: number;
}

export interface RetrievedChunk {
  missionId: string;
  source: 'input' | 'output';
  text: string;
  sparseScore: number;
  denseScore: number;
  combinedScore: number;
}

export interface HybridRetrievalStats {
  totalChunks: number;
  topK: number;
  sparseWeight: number;
  denseWeight: number;
}

export interface ContextSummaryV3 extends ContextSummaryV2 {
  retrievedChunks: RetrievedChunk[];
  retrievalStats: HybridRetrievalStats;
}

interface TokenVector {
  weights: Map<string, number>;
  norm: number;
}

interface CorpusChunk {
  missionId: string;
  source: 'input' | 'output';
  text: string;
  tokens: string[];
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'from',
  'this',
  'have',
  'will',
  'into',
  'your',
  'about',
  'over',
  'under',
  'between',
  'within',
  'through',
  'while',
  'where',
  'which',
  'when',
  'what',
  'shall',
  'should',
  'would',
  'could',
  'into',
  'onto',
  'across',
  'their',
  'there',
]);

export class ContextPropagatorV3 extends ContextPropagatorV2 {
  private readonly defaultChunkTokens: number;
  private readonly defaultChunkOverlap: number;

  constructor(
    config: ContextPropagatorConfig,
    historyAnalyzer: MissionHistoryAnalyzer = new MissionHistoryAnalyzer({ sessionsPath: '' })
  ) {
    super(config, historyAnalyzer);
    this.defaultChunkTokens = Math.max(120, Math.floor(config.maxContextTokens / 6));
    this.defaultChunkOverlap = Math.max(20, Math.floor(this.defaultChunkTokens / 6));
  }

  async propagateContext(
    originalMission: string,
    completedResults: SubMissionResult[],
    currentSubMission: string,
    options: HybridRetrievalOptions = {}
  ): Promise<ContextSummaryV3> {
    const baseSummary = await super.propagateContext(
      originalMission,
      completedResults,
      currentSubMission,
      options
    );

    const retrieval = this.runHybridRetrieval(originalMission, completedResults, options);

    const augmentedSummary =
      retrieval.contextBlock.length === 0
        ? baseSummary.summary
        : `${baseSummary.summary}\n\n${retrieval.contextBlock}`;

    return {
      ...baseSummary,
      summary: augmentedSummary,
      retrievedChunks: retrieval.retrievedChunks,
      retrievalStats: retrieval.stats,
    };
  }

  private runHybridRetrieval(
    originalMission: string,
    completedResults: SubMissionResult[],
    options: HybridRetrievalOptions
  ): {
    contextBlock: string;
    retrievedChunks: RetrievedChunk[];
    stats: HybridRetrievalStats;
  } {
    const retrievalCount = Math.max(1, options.retrievalCount ?? 4);
    const chunkTokens = Math.max(40, options.chunkTokens ?? this.defaultChunkTokens);
    const overlapTokens = Math.min(
      Math.floor(chunkTokens / 2),
      Math.max(10, options.chunkOverlapTokens ?? this.defaultChunkOverlap)
    );
    const sparseWeight = this.normalizeWeight(options.sparseWeight ?? 0.55);
    const denseWeight = this.normalizeWeight(options.denseWeight ?? 0.45);

    if (completedResults.length === 0) {
      return {
        contextBlock: '',
        retrievedChunks: [],
        stats: {
          totalChunks: 0,
          topK: 0,
          sparseWeight,
          denseWeight,
        },
      };
    }

    const queryText = (options.query ?? this.buildQuery(originalMission, completedResults)).trim();
    if (queryText.length === 0) {
      return {
        contextBlock: '',
        retrievedChunks: [],
        stats: {
          totalChunks: 0,
          topK: 0,
          sparseWeight,
          denseWeight,
        },
      };
    }

    const corpus = this.buildCorpus(completedResults, chunkTokens, overlapTokens);
    if (corpus.length === 0) {
      return {
        contextBlock: '',
        retrievedChunks: [],
        stats: {
          totalChunks: 0,
          topK: 0,
          sparseWeight,
          denseWeight,
        },
      };
    }

    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) {
      return {
        contextBlock: '',
        retrievedChunks: [],
        stats: {
          totalChunks: corpus.length,
          topK: 0,
          sparseWeight,
          denseWeight,
        },
      };
    }

    const queryVector = this.toVector(queryTokens);

    const scoredChunks: RetrievedChunk[] = corpus.map((chunk) => {
      const sparseScore = this.computeSparseScore(queryTokens, chunk.tokens);
      const denseScore = this.computeDenseScore(queryVector, this.toVector(chunk.tokens));
      const combinedScore = sparseWeight * sparseScore + denseWeight * denseScore;
      return {
        missionId: chunk.missionId,
        source: chunk.source,
        text: chunk.text,
        sparseScore,
        denseScore,
        combinedScore,
      };
    });

    const retrievedChunks = scoredChunks
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, retrievalCount)
      .filter((chunk) => chunk.combinedScore > 0);

    const contextBlock =
      retrievedChunks.length === 0 ? '' : this.composeContextBlock(retrievedChunks);

    return {
      contextBlock,
      retrievedChunks,
      stats: {
        totalChunks: corpus.length,
        topK: retrievedChunks.length,
        sparseWeight,
        denseWeight,
      },
    };
  }

  private buildQuery(originalMission: string, completedResults: SubMissionResult[]): string {
    const parts = [originalMission];
    const lastResult = completedResults[completedResults.length - 1];
    if (lastResult) {
      if (lastResult.output?.length) {
        parts.push(lastResult.output);
      }
      if (lastResult.input?.length) {
        parts.push(lastResult.input);
      }
    }
    return parts.join('\n');
  }

  private buildCorpus(
    completedResults: SubMissionResult[],
    chunkTokens: number,
    overlapTokens: number
  ): CorpusChunk[] {
    const chunks: CorpusChunk[] = [];

    for (const result of completedResults) {
      const missionId = result.missionId;

      if (result.input?.trim()) {
        const inputChunks = this.chunkText(result.input, chunkTokens, overlapTokens);
        for (const text of inputChunks) {
          const tokens = this.tokenize(text);
          if (tokens.length > 0) {
            chunks.push({
              missionId,
              source: 'input',
              text,
              tokens,
            });
          }
        }
      }

      if (result.output?.trim()) {
        const outputChunks = this.chunkText(result.output, chunkTokens, overlapTokens);
        for (const text of outputChunks) {
          const tokens = this.tokenize(text);
          if (tokens.length > 0) {
            chunks.push({
              missionId,
              source: 'output',
              text,
              tokens,
            });
          }
        }
      }
    }

    return chunks;
  }

  private chunkText(text: string, targetTokens: number, overlapTokens: number): string[] {
    const words = text.split(/\s+/).filter((word) => word.trim().length > 0);

    const chunks: string[] = [];
    let start = 0;

    while (start < words.length) {
      const end = Math.min(words.length, start + targetTokens);
      const slice = words.slice(start, end).join(' ');
      chunks.push(slice.trim());
      if (end === words.length) {
        break;
      }
      start = Math.max(0, end - overlapTokens);
    }

    return chunks;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  }

  private toVector(tokens: string[]): TokenVector {
    const weights = new Map<string, number>();
    for (const token of tokens) {
      weights.set(token, (weights.get(token) ?? 0) + 1);
    }

    let normSquared = 0;
    for (const value of weights.values()) {
      normSquared += value * value;
    }

    return {
      weights,
      norm: Math.sqrt(normSquared),
    };
  }

  private computeSparseScore(queryTokens: string[], chunkTokens: string[]): number {
    const querySet = new Set(queryTokens);
    let matches = 0;
    for (const token of chunkTokens) {
      if (querySet.has(token)) {
        matches += 1;
      }
    }

    return matches / querySet.size;
  }

  private computeDenseScore(queryVector: TokenVector, chunkVector: TokenVector): number {
    let dot = 0;
    for (const [token, weight] of queryVector.weights.entries()) {
      const other = chunkVector.weights.get(token);
      if (other) {
        dot += weight * other;
      }
    }

    return dot / (queryVector.norm * chunkVector.norm);
  }

  private composeContextBlock(retrievedChunks: RetrievedChunk[]): string {
    const lines: string[] = ['=== HYBRID RAG CONTEXT ==='];
    retrievedChunks.forEach((chunk, index) => {
      const header = `Chunk ${index + 1} | Mission ${chunk.missionId} (${chunk.source}) | score=${chunk.combinedScore.toFixed(
        2
      )}`;
      lines.push(header);
      lines.push(chunk.text.trim());
    });
    return lines.join('\n');
  }

  private normalizeWeight(weight: number): number {
    if (!Number.isFinite(weight) || weight <= 0) {
      return 0.5;
    }
    return Math.min(1, Math.max(0, weight));
  }
}
