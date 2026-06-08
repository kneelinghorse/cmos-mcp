import * as yaml from 'js-yaml';
import { promises as fs } from 'fs';
import {
  DependencyAnalyzer,
  DependencyAnalysisResult,
  MissionInput,
  MissionRecord,
  MissionDomainFields,
  isMissionRecord,
} from './dependency-analyzer';
import { MissionHistoryAnalyzer, MissionTransitionEdge } from './mission-history';
import {
  LifecycleAnalyzer,
  LifecycleDependencyHint,
  LifecycleAnomaly,
  LifecyclePhaseAssignment,
} from './lifecycle-analyzer';

export interface EnhancedDependencyAnalysisResult extends DependencyAnalysisResult {
  historyDependencies: MissionTransitionEdge[];
  lifecycleDependencies: LifecycleDependencyHint[];
  lifecycleWarnings: LifecycleAnomaly[];
  lifecycleAssignments: Record<string, LifecyclePhaseAssignment[]>;
}

/**
 * EnhancedDependencyAnalyzer
 *
 * Extends the baseline dependency analyzer by injecting implicit dependencies
 * discovered from execution history. This allows mission planning to account
 * for historical sequencing patterns and explicit next-hint recommendations.
 */
export class EnhancedDependencyAnalyzer {
  constructor(
    private readonly historyAnalyzer: MissionHistoryAnalyzer = new MissionHistoryAnalyzer(),
    private readonly dependencyAnalyzer: DependencyAnalyzer = new DependencyAnalyzer(),
    private readonly lifecycleAnalyzer: LifecycleAnalyzer = new LifecycleAnalyzer()
  ) {}

  async analyze(missions: MissionInput[]): Promise<EnhancedDependencyAnalysisResult> {
    const missionRecords = await this.loadMissionRecords(missions);
    const missionMap = new Map<string, MissionRecord>();
    for (const record of missionRecords) {
      missionMap.set(record.missionId, record);
    }

    const historyTransitions = await this.historyAnalyzer.deriveTransitions();
    const relevantTransitions = historyTransitions.filter(
      (edge) => missionMap.has(edge.from) && missionMap.has(edge.to)
    );

    const historyDependencyMap = new Map<string, Set<string>>();
    for (const edge of relevantTransitions) {
      if (!historyDependencyMap.has(edge.from)) {
        historyDependencyMap.set(edge.from, new Set());
      }
      historyDependencyMap.get(edge.from)!.add(edge.to);
    }

    const lifecycleAnalysis = this.lifecycleAnalyzer.analyze(missionRecords);

    const lifecycleDependencyMap = new Map<string, Set<string>>();
    for (const hint of lifecycleAnalysis.dependencies) {
      if (!missionMap.has(hint.from) || !missionMap.has(hint.to)) {
        continue;
      }
      if (!lifecycleDependencyMap.has(hint.from)) {
        lifecycleDependencyMap.set(hint.from, new Set());
      }
      lifecycleDependencyMap.get(hint.from)!.add(hint.to);
    }

    const lifecycleWarningsMap = new Map<string, LifecycleAnomaly[]>();
    for (const anomaly of lifecycleAnalysis.anomalies) {
      if (!missionMap.has(anomaly.missionId)) {
        continue;
      }
      if (!lifecycleWarningsMap.has(anomaly.missionId)) {
        lifecycleWarningsMap.set(anomaly.missionId, []);
      }
      lifecycleWarningsMap.get(anomaly.missionId)!.push(anomaly);
    }

    const augmentedMissions = missionRecords.map((record) => {
      const existingDomainFields = { ...(record.domainFields ?? {}) } as MissionDomainFields;
      const existingHandoff = {
        ...(existingDomainFields.handoffContext ?? {}),
      } as Record<string, unknown>;

      const existingDeps = new Set<string>(
        Array.isArray(existingHandoff.dependencies)
          ? (existingHandoff.dependencies as string[])
          : []
      );

      let dependenciesChanged = false;
      const historyDeps = historyDependencyMap.get(record.missionId);
      if (historyDeps) {
        for (const dep of historyDeps) {
          if (!existingDeps.has(dep)) {
            existingDeps.add(dep);
            dependenciesChanged = true;
          }
        }
      }

      const lifecycleDeps = lifecycleDependencyMap.get(record.missionId);
      if (lifecycleDeps) {
        for (const dep of lifecycleDeps) {
          if (!existingDeps.has(dep)) {
            existingDeps.add(dep);
            dependenciesChanged = true;
          }
        }
      }

      const lifecyclePhases = lifecycleAnalysis.assignments[record.missionId] ?? [];
      const lifecycleWarnings = lifecycleWarningsMap.get(record.missionId) ?? [];

      const updatedDomainFields: MissionDomainFields = { ...existingDomainFields };

      const handoffUpdates: Record<string, unknown> = { ...existingHandoff };
      const implicitLifecycleDeps = lifecycleDeps ? Array.from(lifecycleDeps) : [];
      const implicitHistoryDeps = historyDeps ? Array.from(historyDeps) : [];

      if (dependenciesChanged || Array.isArray(existingHandoff.dependencies)) {
        handoffUpdates.dependencies = Array.from(existingDeps);
      }
      if (implicitLifecycleDeps.length > 0) {
        handoffUpdates.implicitLifecycleDependencies = implicitLifecycleDeps;
      }
      if (implicitHistoryDeps.length > 0) {
        handoffUpdates.implicitHistoryDependencies = implicitHistoryDeps;
      }

      if (Object.keys(handoffUpdates).length > 0) {
        updatedDomainFields.handoffContext = handoffUpdates;
      }

      const existingLifecycle =
        typeof existingDomainFields.lifecycle === 'object' &&
        existingDomainFields.lifecycle !== null
          ? (existingDomainFields.lifecycle as Record<string, unknown>)
          : {};
      const lifecycleMetadata: Record<string, unknown> = { ...existingLifecycle };
      if (lifecyclePhases.length > 0) {
        lifecycleMetadata.phases = lifecyclePhases;
      }
      if (lifecycleWarnings.length > 0) {
        lifecycleMetadata.warnings = lifecycleWarnings;
      }
      if (Object.keys(lifecycleMetadata).length > 0) {
        updatedDomainFields.lifecycle = lifecycleMetadata;
      }

      const augmentedRecord: MissionRecord = {
        ...record,
        domainFields: updatedDomainFields,
      };

      return augmentedRecord;
    });

    const result = await this.dependencyAnalyzer.analyze(augmentedMissions);

    // Annotate implicit dependencies for downstream consumers
    for (const [missionId, deps] of historyDependencyMap.entries()) {
      const node = result.graph.nodes.get(missionId);
      if (!node) {
        continue;
      }
      const implicit = new Set(node.implicitDependencies ?? []);
      for (const dep of deps) {
        implicit.add(dep);
      }
      node.implicitDependencies = Array.from(implicit);
    }

    for (const [missionId, deps] of lifecycleDependencyMap.entries()) {
      const node = result.graph.nodes.get(missionId);
      if (!node) {
        continue;
      }
      const implicit = new Set(node.implicitDependencies ?? []);
      for (const dep of deps) {
        implicit.add(dep);
      }
      node.implicitDependencies = Array.from(implicit);
    }

    return {
      ...result,
      historyDependencies: relevantTransitions,
      lifecycleDependencies: lifecycleAnalysis.dependencies,
      lifecycleWarnings: lifecycleAnalysis.anomalies,
      lifecycleAssignments: lifecycleAnalysis.assignments,
    };
  }

  private async loadMissionRecords(inputs: MissionInput[]): Promise<MissionRecord[]> {
    const records: MissionRecord[] = [];

    for (const mission of inputs) {
      if (typeof mission === 'string') {
        const filePath = mission;
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = yaml.load(content);

        if (!isMissionRecord(parsed)) {
          throw new Error(`Invalid mission data encountered at ${filePath}`);
        }

        records.push({ ...parsed, filePath });
        continue;
      }

      records.push({ ...mission });
    }

    return records;
  }
}
