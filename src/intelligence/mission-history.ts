import { promises as fs } from 'fs';
import { dirname } from 'path';

const MISSION_ID_PATTERN = /\b[A-Z]\d+\.\d+\b/g;

export interface MissionHistoryEvent {
  ts: string;
  mission: string;
  action: string;
  status?: string;
  agent?: string;
  summary?: string;
  next_hint?: string;
  needs?: string[];
}

export interface MissionTransitionEdge {
  from: string;
  to: string;
  confidence: number;
  reason: string;
  source: 'next_hint' | 'sequence';
  ts: string;
}

export interface MissionHistoryHighlight {
  missionId: string;
  ts: string;
  summary?: string;
  agent?: string;
}

export interface MissionHistoryOptions {
  sessionsPath?: string;
}

/**
 * MissionHistoryAnalyzer
 *
 * Utility for loading mission execution history from the append-only sessions log.
 * Provides helpers for deriving implicit sequencing relationships and surfacing
 * highlights that can be fed back into dependency and context intelligence.
 */
export class MissionHistoryAnalyzer {
  private readonly sessionsPath: string;

  constructor(options: MissionHistoryOptions = {}) {
    this.sessionsPath = options.sessionsPath ?? 'SESSIONS.jsonl';
  }

  /**
   * Load and parse mission events from the JSONL sessions log.
   */
  async loadEvents(): Promise<MissionHistoryEvent[]> {
    const raw = await this.readSessionsLog();
    const events: MissionHistoryEvent[] = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as MissionHistoryEvent;
        if (parsed?.mission && parsed?.action && parsed?.ts) {
          events.push(parsed);
        }
      } catch {
        // Ignore malformed history lines - the log is append-only best-effort.
      }
    }

    return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }

  /**
   * Derive implicit mission transition edges based on historical data.
   * Currently leverages two signals:
   *  - Explicit next_hint references captured during completion events.
   *  - Sequential "complete" -> "start" transitions in the event stream.
   */
  async deriveTransitions(): Promise<MissionTransitionEdge[]> {
    const events = await this.loadEvents();
    const edges: MissionTransitionEdge[] = [];
    const seen = new Set<string>();

    // 1. Explicit next_hint transitions
    for (const event of events) {
      if (event.action !== 'complete' || !event.next_hint) {
        continue;
      }

      const referencedMissions = this.extractMissionIds(event.next_hint);
      for (const missionId of referencedMissions) {
        if (!missionId || missionId === event.mission) {
          continue;
        }

        const key = `${missionId}->${event.mission}@hint`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        edges.push({
          from: missionId,
          to: event.mission,
          confidence: 0.75,
          reason: `next_hint:${event.next_hint}`,
          source: 'next_hint',
          ts: event.ts,
        });
      }
    }

    // 2. Sequential start after completion
    for (let i = 0; i < events.length - 1; i++) {
      const current = events[i];
      const next = events[i + 1];

      if (current.action === 'complete' && next.action === 'start') {
        if (current.mission === next.mission) {
          continue;
        }

        const key = `${next.mission}->${current.mission}@sequence`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        edges.push({
          from: next.mission,
          to: current.mission,
          confidence: 0.5,
          reason: `sequence:${current.mission}->${next.mission}`,
          source: 'sequence',
          ts: next.ts,
        });
      }
    }

    return edges;
  }

  /**
   * Return recent completion highlights for the provided mission ids.
   */
  async collectHighlights(
    missionIds: Iterable<string>,
    limitPerMission = 1
  ): Promise<MissionHistoryHighlight[]> {
    const events = await this.loadEvents();
    const highlights: MissionHistoryHighlight[] = [];
    const missionSet = new Set(missionIds);

    if (missionSet.size === 0) {
      return highlights;
    }

    for (const missionId of missionSet) {
      const completions = events
        .filter((event) => event.mission === missionId && event.action === 'complete')
        .slice(-limitPerMission);

      for (const completion of completions) {
        highlights.push({
          missionId,
          ts: completion.ts,
          summary: completion.summary,
          agent: completion.agent,
        });
      }
    }

    return highlights.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }

  private extractMissionIds(value: string): string[] {
    return Array.from(value.match(MISSION_ID_PATTERN) ?? []);
  }

  private async readSessionsLog(): Promise<string> {
    try {
      return await fs.readFile(this.sessionsPath, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (!err || err.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.mkdir(dirname(this.sessionsPath), { recursive: true });
    await fs.writeFile(this.sessionsPath, '', 'utf-8');
    return '';
  }
}
