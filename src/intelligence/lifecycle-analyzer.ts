import { MissionRecord } from './dependency-analyzer';

export type LifecyclePhaseType = 'PDLC' | 'SDLC';

export interface LifecyclePhaseAssignment {
  phaseType: LifecyclePhaseType;
  phase: string;
  confidence: number;
  score: number;
  evidence: string[];
}

export interface LifecycleDependencyHint {
  from: string;
  to: string;
  phaseType: LifecyclePhaseType;
  phase: string;
  requiredPhase: string;
  confidence: number;
  reason: string;
  source: 'lifecycle-sequencing' | 'artifact-flow';
  artifactName?: string;
}

export interface LifecycleAnomaly {
  missionId: string;
  phaseType: LifecyclePhaseType;
  phase: string;
  issue: string;
  severity: 'warning' | 'error';
  missingPrerequisites?: string[];
}

export interface LifecycleAnalysis {
  assignments: Record<string, LifecyclePhaseAssignment[]>;
  dependencies: LifecycleDependencyHint[];
  anomalies: LifecycleAnomaly[];
}

interface LifecycleAnalyzerConfig {
  minAssignmentConfidence?: number;
  dependencyConfidenceThreshold?: number;
}

interface PhaseHeuristic {
  phaseType: LifecyclePhaseType;
  phase: string;
  keywordTriggers: string[];
  artifactTriggers: string[];
  typeHints?: string[];
  missionPrefixHints?: string[];
  roleTriggers?: string[];
}

interface ArtifactIndexEntry {
  missionId: string;
  artifact: string;
}

const KEYWORD_WEIGHT = 0.18;
const ARTIFACT_WEIGHT = 0.22;
const TYPE_HINT_WEIGHT = 0.28;
const PREFIX_WEIGHT = 0.18;
const ROLE_WEIGHT = 0.16;

const PHASE_ORDERS: Record<LifecyclePhaseType, string[]> = {
  PDLC: [
    'Ideation',
    'Research & Validation',
    'Concept & Strategy',
    'Prototyping & MVP',
    'Launch Planning',
    'Product Launch',
    'Growth & Maturity',
    'Decline & Sunsetting',
  ],
  SDLC: [
    'Requirements Analysis',
    'System Design',
    'Implementation',
    'Testing & QA',
    'Deployment',
    'Maintenance',
  ],
};

const PHASE_HEURISTICS: PhaseHeuristic[] = [
  {
    phaseType: 'PDLC',
    phase: 'Ideation',
    keywordTriggers: [
      'ideation',
      'brainstorm',
      'brainstorming',
      'idea',
      'ideas',
      'concept workshop',
      'idea backlog',
      'vision statement',
      'problem discovery',
    ],
    artifactTriggers: ['concept brief', 'innovation log', 'idea backlog', 'vision doc'],
    missionPrefixHints: ['I'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Research & Validation',
    keywordTriggers: [
      'research study',
      'market research',
      'user interview',
      'interviews',
      'interview',
      'validation',
      'validation study',
      'competitive analysis',
      'survey',
      'usability testing',
      'customer insight',
      'insights',
    ],
    artifactTriggers: [
      'research report',
      'validation summary',
      'user insights',
      'insights report',
      'research findings',
      'validation report',
    ],
    missionPrefixHints: ['R'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Concept & Strategy',
    keywordTriggers: [
      'strategy',
      'business case',
      'go-to-market',
      'positioning',
      'product strategy',
      'roadmap',
    ],
    artifactTriggers: ['business case', 'product strategy', 'roadmap'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Prototyping & MVP',
    keywordTriggers: ['prototype', 'mvp', 'proof of concept', 'mockup', 'spike solution'],
    artifactTriggers: ['prototype build', 'mvp demo', 'interactive mockup'],
    missionPrefixHints: ['B'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Launch Planning',
    keywordTriggers: [
      'launch plan',
      'release planning',
      'enablement',
      'training materials',
      'launch readiness',
    ],
    artifactTriggers: ['launch checklist', 'release plan', 'enablement kit'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Product Launch',
    keywordTriggers: ['launch', 'go live', 'release event', 'product launch', 'market release'],
    artifactTriggers: ['launch report', 'release announcement', 'launch metrics'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Growth & Maturity',
    keywordTriggers: ['growth', 'optimization', 'scale', 'maturity', 'retention', 'expansion'],
    artifactTriggers: ['growth playbook', 'optimization plan', 'performance dashboard'],
  },
  {
    phaseType: 'PDLC',
    phase: 'Decline & Sunsetting',
    keywordTriggers: ['sunset', 'deprecation', 'retirement', 'wind down', 'end-of-life'],
    artifactTriggers: ['sunset plan', 'deprecation announcement', 'retirement checklist'],
  },
  {
    phaseType: 'SDLC',
    phase: 'Requirements Analysis',
    keywordTriggers: [
      'requirements',
      'acceptance criteria',
      'user story',
      'analysis',
      'functional spec',
      'prd',
    ],
    artifactTriggers: [
      'requirements doc',
      'requirements specification',
      'product requirements document',
    ],
    typeHints: ['requirements', 'analysis', 'discovery'],
  },
  {
    phaseType: 'SDLC',
    phase: 'System Design',
    keywordTriggers: [
      'system design',
      'architecture',
      'design review',
      'solution design',
      'uml',
      'sequence diagram',
    ],
    artifactTriggers: ['design doc', 'architecture diagram', 'design specification'],
    typeHints: ['design'],
  },
  {
    phaseType: 'SDLC',
    phase: 'Implementation',
    keywordTriggers: [
      'implementation',
      'develop',
      'build feature',
      'coding',
      'integrate',
      'application logic',
    ],
    artifactTriggers: ['source code', 'repository', 'implementation plan'],
    typeHints: ['implementation', 'build'],
    missionPrefixHints: ['B'],
    roleTriggers: ['engineer', 'developer'],
  },
  {
    phaseType: 'SDLC',
    phase: 'Testing & QA',
    keywordTriggers: ['testing', 'qa', 'verification', 'validation', 'test plan', 'regression'],
    artifactTriggers: ['test report', 'qa plan', 'test results'],
    typeHints: ['quality', 'testing'],
    missionPrefixHints: ['Q'],
    roleTriggers: ['qa', 'tester'],
  },
  {
    phaseType: 'SDLC',
    phase: 'Deployment',
    keywordTriggers: ['deployment', 'release', 'rollout', 'shipping', 'go-live', 'production push'],
    artifactTriggers: ['deployment plan', 'release checklist', 'runbook'],
    typeHints: ['deployment', 'operations'],
    missionPrefixHints: ['D'],
    roleTriggers: ['devops', 'sre'],
  },
  {
    phaseType: 'SDLC',
    phase: 'Maintenance',
    keywordTriggers: ['maintenance', 'support', 'monitor', 'sustain', 'bug fix', 'operations'],
    artifactTriggers: ['runbook', 'maintenance log', 'support playbook'],
    typeHints: ['maintenance', 'support'],
    missionPrefixHints: ['M'],
  },
];

const DEFAULT_MIN_ASSIGNMENT_CONFIDENCE = 0.45;
const DEFAULT_DEPENDENCY_CONFIDENCE = 0.7;

/**
 * LifecycleAnalyzer
 *
 * Detects PDLC/SDLC phases for missions and infers implicit dependencies based on canonical phase order
 * and artifact flow. Provides lifecycle anomalies when sequencing violations are detected.
 */
export class LifecycleAnalyzer {
  private readonly config: Required<LifecycleAnalyzerConfig>;

  constructor(config: LifecycleAnalyzerConfig = {}) {
    this.config = {
      minAssignmentConfidence: config.minAssignmentConfidence ?? DEFAULT_MIN_ASSIGNMENT_CONFIDENCE,
      dependencyConfidenceThreshold:
        config.dependencyConfidenceThreshold ?? DEFAULT_DEPENDENCY_CONFIDENCE,
    };
  }

  analyze(missions: MissionRecord[]): LifecycleAnalysis {
    const assignments: Record<string, LifecyclePhaseAssignment[]> = {};
    const textIndex = new Map<string, string>();
    const artifactIndex = new Map<string, ArtifactIndexEntry[]>();
    const dependencies: LifecycleDependencyHint[] = [];
    const anomalies: LifecycleAnomaly[] = [];

    for (const mission of missions) {
      const detected = this.detectPhases(mission);
      if (detected.length > 0) {
        assignments[mission.missionId] = detected;
      }

      const missionText = this.collectMissionText(mission);
      textIndex.set(mission.missionId, missionText);

      const artifacts = this.extractArtifacts(mission);
      for (const artifact of artifacts) {
        if (!this.isArtifactCandidate(artifact)) {
          continue;
        }

        const normalized = artifact.toLowerCase();
        if (!artifactIndex.has(normalized)) {
          artifactIndex.set(normalized, []);
        }
        artifactIndex.get(normalized)!.push({ missionId: mission.missionId, artifact });
      }
    }

    const lifecycleResults = this.buildLifecycleDependencies(missions, assignments);
    dependencies.push(...lifecycleResults.dependencies);
    anomalies.push(...lifecycleResults.anomalies);

    const artifactDependencies = this.buildArtifactDependencies(
      missions,
      assignments,
      textIndex,
      artifactIndex
    );
    dependencies.push(...artifactDependencies.dependencies);
    anomalies.push(...artifactDependencies.anomalies);

    return {
      assignments,
      dependencies,
      anomalies,
    };
  }

  private detectPhases(mission: MissionRecord): LifecyclePhaseAssignment[] {
    const assignments: LifecyclePhaseAssignment[] = [];

    for (const heuristic of PHASE_HEURISTICS) {
      const assignment = this.evaluateHeuristic(mission, heuristic);
      if (assignment && assignment.confidence >= this.config.minAssignmentConfidence) {
        assignments.push(assignment);
      }
    }

    assignments.sort((a, b) => b.confidence - a.confidence);
    return assignments;
  }

  private evaluateHeuristic(
    mission: MissionRecord,
    heuristic: PhaseHeuristic
  ): LifecyclePhaseAssignment | null {
    const evidence: string[] = [];
    let score = 0;

    const lowerText = this.collectMissionText(mission);
    const deliverables = this.collectMissionDeliverables(mission);
    const lowerType =
      typeof mission.domainFields?.type === 'string'
        ? mission.domainFields!.type!.toLowerCase()
        : '';

    const roleEntries = this.collectRoleEntries(mission);

    let keywordHits = 0;
    for (const keyword of heuristic.keywordTriggers) {
      if (this.textContains(lowerText, keyword)) {
        keywordHits += 1;
        evidence.push(`Keyword "${keyword}" detected`);
      }
    }
    score += Math.min(keywordHits, 3) * KEYWORD_WEIGHT;

    let artifactHits = 0;
    for (const artifact of heuristic.artifactTriggers) {
      if (
        deliverables.some((deliverable) => this.textContains(deliverable, artifact)) ||
        this.textContains(lowerText, artifact)
      ) {
        artifactHits += 1;
        evidence.push(`Artifact signal "${artifact}" found`);
      }
    }
    score += Math.min(artifactHits, 2) * ARTIFACT_WEIGHT;

    if (heuristic.typeHints && lowerType) {
      let matched = 0;
      for (const hint of heuristic.typeHints) {
        if (lowerType.includes(hint.toLowerCase())) {
          matched += 1;
          evidence.push(`Type hint "${hint}" matched`);
        }
      }
      score += Math.min(matched, 2) * TYPE_HINT_WEIGHT;
    }

    if (heuristic.missionPrefixHints) {
      const firstChar = mission.missionId?.[0];
      if (firstChar) {
        for (const prefix of heuristic.missionPrefixHints) {
          if (firstChar.toUpperCase() === prefix.toUpperCase()) {
            score += PREFIX_WEIGHT;
            evidence.push(`Mission ID prefix "${prefix}" matched`);
            break;
          }
        }
      }
    }

    if (heuristic.roleTriggers && roleEntries.length > 0) {
      let roleHits = 0;
      for (const roleTrigger of heuristic.roleTriggers) {
        if (roleEntries.some((role) => role.includes(roleTrigger.toLowerCase()))) {
          roleHits += 1;
          evidence.push(`Role signal "${roleTrigger}" detected`);
        }
      }
      score += Math.min(roleHits, 2) * ROLE_WEIGHT;
    }

    const clampedScore = Math.min(score, 1);
    if (clampedScore <= 0) {
      return null;
    }

    return {
      phaseType: heuristic.phaseType,
      phase: heuristic.phase,
      confidence: parseFloat(clampedScore.toFixed(2)),
      score: parseFloat(score.toFixed(2)),
      evidence,
    };
  }

  private buildLifecycleDependencies(
    missions: MissionRecord[],
    assignments: Record<string, LifecyclePhaseAssignment[]>
  ): { dependencies: LifecycleDependencyHint[]; anomalies: LifecycleAnomaly[] } {
    const dependencies: LifecycleDependencyHint[] = [];
    const anomalies: LifecycleAnomaly[] = [];
    const dependencyKeys = new Set<string>();

    for (const phaseType of Object.keys(PHASE_ORDERS) as LifecyclePhaseType[]) {
      const order = PHASE_ORDERS[phaseType];
      const orderIndex = new Map(order.map((phase, index) => [phase, index]));

      const typedAssignments = missions
        .map((mission) => {
          const primary = this.getPrimaryAssignment(assignments[mission.missionId], phaseType);
          return primary ? { missionId: mission.missionId, assignment: primary } : null;
        })
        .filter(
          (value): value is { missionId: string; assignment: LifecyclePhaseAssignment } =>
            value !== null
        )
        .sort((a, b) => {
          const aIndex = orderIndex.get(a.assignment.phase) ?? Number.MAX_SAFE_INTEGER;
          const bIndex = orderIndex.get(b.assignment.phase) ?? Number.MAX_SAFE_INTEGER;
          if (aIndex === bIndex) {
            return b.assignment.confidence - a.assignment.confidence;
          }
          return aIndex - bIndex;
        });

      for (let index = 0; index < typedAssignments.length; index += 1) {
        const current = typedAssignments[index];
        const currentPhaseIndex = orderIndex.get(current.assignment.phase);
        if (currentPhaseIndex === undefined) {
          continue;
        }

        if (current.assignment.confidence < this.config.dependencyConfidenceThreshold) {
          continue;
        }

        const precedingAssignments: { missionId: string; assignment: LifecyclePhaseAssignment }[] =
          [];
        for (let scan = 0; scan < index; scan += 1) {
          const candidate = typedAssignments[scan];
          const candidateIndex = orderIndex.get(candidate.assignment.phase);
          if (candidateIndex !== undefined && candidateIndex < currentPhaseIndex) {
            precedingAssignments.push(candidate);
          }
        }

        const prerequisite =
          precedingAssignments.length > 0
            ? precedingAssignments[precedingAssignments.length - 1]
            : null;

        const requiredPhases = order.slice(0, currentPhaseIndex);
        const completedPhases = new Set(precedingAssignments.map((item) => item.assignment.phase));
        const missingPhases = requiredPhases.filter((phase) => !completedPhases.has(phase));

        if (missingPhases.length > 0) {
          anomalies.push({
            missionId: current.missionId,
            phaseType,
            phase: current.assignment.phase,
            issue: `Missing prerequisite phase(s): ${missingPhases.join(', ')}`,
            severity: 'warning',
            missingPrerequisites: missingPhases,
          });
        }

        if (prerequisite) {
          const dependencyKey = `${current.missionId}->${prerequisite.missionId}:${phaseType}`;
          if (!dependencyKeys.has(dependencyKey)) {
            dependencyKeys.add(dependencyKey);
            dependencies.push({
              from: current.missionId,
              to: prerequisite.missionId,
              phaseType,
              phase: current.assignment.phase,
              requiredPhase: prerequisite.assignment.phase,
              confidence: parseFloat(
                ((current.assignment.confidence + prerequisite.assignment.confidence) / 2).toFixed(
                  2
                )
              ),
              source: 'lifecycle-sequencing',
              reason: `${phaseType} phase "${current.assignment.phase}" follows "${prerequisite.assignment.phase}"`,
            });
          }
        }
      }
    }

    return { dependencies, anomalies };
  }

  private buildArtifactDependencies(
    missions: MissionRecord[],
    assignments: Record<string, LifecyclePhaseAssignment[]>,
    textIndex: Map<string, string>,
    artifactIndex: Map<string, ArtifactIndexEntry[]>
  ): { dependencies: LifecycleDependencyHint[]; anomalies: LifecycleAnomaly[] } {
    const dependencies: LifecycleDependencyHint[] = [];
    const dependencyKeys = new Set<string>();

    const missionDeliverableIndex = new Map<string, string[]>();
    for (const mission of missions) {
      missionDeliverableIndex.set(mission.missionId, this.collectMissionDeliverables(mission));
    }

    for (const [artifactKey, producers] of artifactIndex.entries()) {
      const producer = this.selectStrongestProducer(producers, assignments);
      if (!producer) {
        continue;
      }

      for (const mission of missions) {
        if (mission.missionId === producer.missionId) {
          continue;
        }

        const missionText = textIndex.get(mission.missionId) ?? '';
        const missionDeliverables = missionDeliverableIndex.get(mission.missionId) ?? [];
        const artifactMatchInText = this.textContains(missionText, artifactKey);
        const artifactMatchInDeliverables = missionDeliverables.some((deliverable) =>
          this.textContains(deliverable, artifactKey)
        );

        if (!artifactMatchInText && !artifactMatchInDeliverables) {
          continue;
        }

        const key = `${mission.missionId}->${producer.missionId}:artifact:${artifactKey}`;
        if (dependencyKeys.has(key)) {
          continue;
        }

        dependencyKeys.add(key);
        const producerAssignment = this.getDominantAssignment(assignments[producer.missionId]);
        const consumerAssignment =
          this.getDominantAssignment(assignments[mission.missionId]) ??
          this.getDominantAssignment(assignments[producer.missionId]);

        dependencies.push({
          from: mission.missionId,
          to: producer.missionId,
          phaseType: consumerAssignment?.phaseType ?? producerAssignment?.phaseType ?? 'SDLC',
          phase: consumerAssignment?.phase ?? producerAssignment?.phase ?? 'Implementation',
          requiredPhase: producerAssignment?.phase ?? 'Artifact Production',
          confidence: 0.75,
          source: 'artifact-flow',
          artifactName: producer.artifact,
          reason: `Consumes artifact "${producer.artifact}" produced by ${producer.missionId}`,
        });
      }
    }

    return { dependencies, anomalies: [] };
  }

  private collectMissionText(mission: MissionRecord): string {
    const chunks: string[] = [];

    if (typeof mission.name === 'string') {
      chunks.push(mission.name);
    }
    if (typeof mission.objective === 'string') {
      chunks.push(mission.objective);
    }
    if (typeof mission.context === 'string') {
      chunks.push(mission.context);
    }
    if (mission.successCriteria) {
      chunks.push(
        Array.isArray(mission.successCriteria)
          ? mission.successCriteria.join(' ')
          : mission.successCriteria
      );
    }
    if (mission.deliverables) {
      chunks.push(
        Array.isArray(mission.deliverables) ? mission.deliverables.join(' ') : mission.deliverables
      );
    }
    if (typeof mission.notes === 'string') {
      chunks.push(mission.notes);
    }

    return chunks.join(' ').toLowerCase();
  }

  private collectMissionDeliverables(mission: MissionRecord): string[] {
    if (!mission.deliverables) {
      return [];
    }

    if (Array.isArray(mission.deliverables)) {
      return mission.deliverables
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
    }

    if (typeof mission.deliverables === 'string') {
      return [mission.deliverables.toLowerCase()];
    }

    return [];
  }

  private collectRoleEntries(mission: MissionRecord): string[] {
    const rolesField = mission.domainFields?.teamRoles ?? mission.domainFields?.roles;
    if (!rolesField) {
      return [];
    }

    if (Array.isArray(rolesField)) {
      return rolesField
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
    }

    if (typeof rolesField === 'string') {
      return rolesField
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    }

    return [];
  }

  private extractArtifacts(mission: MissionRecord): string[] {
    const artifacts = new Set<string>();

    const deliverables = this.collectMissionDeliverables(mission);
    for (const deliverable of deliverables) {
      artifacts.add(deliverable);
    }

    const successCriteria = mission.successCriteria;
    if (Array.isArray(successCriteria)) {
      for (const entry of successCriteria) {
        if (typeof entry === 'string') {
          artifacts.add(entry.toLowerCase());
        }
      }
    } else if (typeof successCriteria === 'string') {
      artifacts.add(successCriteria.toLowerCase());
    }

    return Array.from(artifacts);
  }

  private selectStrongestProducer(
    producers: ArtifactIndexEntry[],
    assignments: Record<string, LifecyclePhaseAssignment[]>
  ): ArtifactIndexEntry | null {
    if (producers.length === 0) {
      return null;
    }

    let strongest: ArtifactIndexEntry | null = null;
    let highestConfidence = -1;

    for (const producer of producers) {
      const assignment = this.getDominantAssignment(assignments[producer.missionId]);
      const confidence = assignment?.confidence ?? 0.5;
      if (confidence > highestConfidence) {
        strongest = producer;
        highestConfidence = confidence;
      }
    }

    return strongest;
  }

  private getPrimaryAssignment(
    assignments: LifecyclePhaseAssignment[] | undefined,
    phaseType: LifecyclePhaseType
  ): LifecyclePhaseAssignment | undefined {
    if (!assignments) {
      return undefined;
    }
    return assignments
      .filter((assignment) => assignment.phaseType === phaseType)
      .sort((a, b) => b.confidence - a.confidence)[0];
  }

  private getDominantAssignment(
    assignments: LifecyclePhaseAssignment[] | undefined
  ): LifecyclePhaseAssignment | undefined {
    if (!assignments || assignments.length === 0) {
      return undefined;
    }
    return assignments.slice().sort((a, b) => b.confidence - a.confidence)[0];
  }

  private textContains(haystack: string, needle: string): boolean {
    if (!haystack || !needle) {
      return false;
    }
    const normalizedHaystack = haystack.toLowerCase();
    const normalizedNeedle = needle.toLowerCase();
    if (normalizedNeedle.trim().length === 0) {
      return false;
    }

    if (/\s/.test(normalizedNeedle)) {
      return normalizedHaystack.includes(normalizedNeedle);
    }

    const regex = new RegExp(`\\b${this.escapeRegex(normalizedNeedle)}\\b`, 'i');
    return regex.test(normalizedHaystack);
  }

  private escapeRegex(value: string): string {
    return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  private isArtifactCandidate(value: string): boolean {
    const normalized = value.trim();
    if (normalized.length < 8) {
      return false;
    }

    if (/^\w+$/.test(normalized)) {
      return false;
    }

    return true;
  }
}
