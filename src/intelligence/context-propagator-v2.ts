import {
  ContextPropagator,
  ContextPropagatorConfig,
  ContextSummary,
  SubMissionResult,
} from './context-propagator';
import { MissionHistoryAnalyzer, MissionHistoryHighlight } from './mission-history';

export interface ContextSummaryV2 extends ContextSummary {
  historyHighlights: MissionHistoryHighlight[];
}

export interface ContextPropagatorV2Options {
  includeHistory?: boolean;
  relatedMissionIds?: string[];
  historyLimitPerMission?: number;
}

/**
 * ContextPropagatorV2
 *
 * Builds on the base context propagator by enriching the propagated payload with
 * recent mission history. This gives downstream tooling visibility into relevant
 * completions that shape the current mission context.
 */
export class ContextPropagatorV2 extends ContextPropagator {
  constructor(
    config: ContextPropagatorConfig,
    private readonly historyAnalyzer: MissionHistoryAnalyzer = new MissionHistoryAnalyzer()
  ) {
    super(config);
  }

  async propagateContext(
    originalMission: string,
    completedResults: SubMissionResult[],
    currentSubMission: string,
    options: ContextPropagatorV2Options = {}
  ): Promise<ContextSummaryV2> {
    const summary = await super.propagateContext(
      originalMission,
      completedResults,
      currentSubMission
    );

    if (options.includeHistory === false) {
      return {
        ...summary,
        historyHighlights: [],
      };
    }

    const relatedMissionIds = options.relatedMissionIds ?? [];
    const historyHighlights = relatedMissionIds.length
      ? await this.historyAnalyzer.collectHighlights(
          relatedMissionIds,
          options.historyLimitPerMission ?? 1
        )
      : [];

    return {
      ...summary,
      historyHighlights,
    };
  }
}
