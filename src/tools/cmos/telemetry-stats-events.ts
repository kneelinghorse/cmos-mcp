// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Aggregate local event counts, typed same-session uses, and emitted injection costs for stats.
// ABOUTME: Preserve missing denominators and report observational evidence without claiming hook coverage.

import type { TelemetryRecord } from './local-telemetry';
import { isCeremonyCommand } from './prompt-patterns';
import { storedTimeMs } from './stored-time';

export interface ProjectEvents {
  readonly target: string;
  readonly records: readonly TelemetryRecord[];
}

export const EVENT_COUNTING_RULES = {
  prompting:
    'Each hook prompt counts once; procedure pattern matches exclude /cmos:* commands. Zero observed matches does not prove complete hook coverage.',
  citeThrough:
    'Distinct (store, harness session, typed id) per injection surface; a later successful write citation or explicit action in that same store/session counts once. G1 uses prompt injections only, with a provisional 10% floor; a missing denominator is unavailable.',
  repeated:
    'An item injected in at least 2 distinct harness sessions with no later successful use in any of its observed injection sessions.',
  restatement:
    'Prompts with at least one restated rule id per 100 prompts carrying the restatement instrument; failed or absent measurements are excluded and counted separately.',
  cache:
    'Within each store and UTC day, keep the last digest hash per harness session; comparable days have at least 2 sessions, stable sessions share their hash with another session that day.',
  injection:
    'Actual emitted post-cap characters, grouped by injection surface and session. An injection with no session contributes characters but cannot join a session denominator.',
  safety:
    'One record per invocation; failOpens count non-null causes, deadlineMisses are their deadline subset, refusals count non-null refusal codes.',
  comparison:
    'On versus digest-off groups are observational; the scheduled comparison waits until after the G1 read.',
} as const;

type Surface = 'digest' | 'prompt' | 'other';
const surfaceOf = (r: TelemetryRecord): Surface =>
  r.tool === 'hook session-start' ? 'digest' : r.tool === 'hook prompt' ? 'prompt' : 'other';
const sessionOf = (r: TelemetryRecord): string | null => {
  const session = r.session?.replace(/^ext:/, '');
  return session && /^[a-f0-9]{16}$/.test(session) ? session : null;
};
const ids = (values: readonly string[] | undefined): string[] =>
  (values ?? []).filter((id) => /^[dlcn]:[1-9]\d*$/.test(id));
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

interface Exposure {
  target: string;
  session: string;
  id: string;
  time: number;
  surface: Surface;
}

/** No text parsing here: the writers have already supplied typed ids and instrument results. */
export function eventStatistics(projects: readonly ProjectEvents[]) {
  const all = projects.flatMap(({ target, records }) =>
    records.map((record) => ({ target, record }))
  );
  const prompts = all.filter(
    ({ record }) => record.surface === 'hook' && record.tool === 'hook prompt'
  );
  const measuredPrompts = prompts.filter(({ record }) => Array.isArray(record.procedurePatternIds));
  const restatementPrompts = prompts.filter(
    ({ record }) => Array.isArray(record.restatedRuleIds) && !record.ruleReadFailed
  );
  const restatedPrompts = restatementPrompts.filter(
    ({ record }) => record.restatedRuleIds!.length > 0
  ).length;
  const exposures = new Map<string, Exposure>();
  const uses = new Map<string, number[]>();
  const itemSessions = new Map<
    string,
    { target: string; id: string; sessions: Set<string>; used: boolean }
  >();
  const digestDays = new Map<string, Map<string, { time: number; hash: string }>>();
  const characterSessions = new Map<string, number>();
  const charactersBySurface = { digest: 0, prompt: 0, other: 0 };
  let characters = 0;
  let unkeyedCharacters = 0;
  let unkeyedInjectedItems = 0;
  for (const { target, record: r } of all) {
    const time = storedTimeMs(r.ts);
    const session = sessionOf(r);
    const surface = surfaceOf(r);
    const cost = Math.max(0, r.charsInjected ?? 0);
    characters += cost;
    charactersBySurface[surface] += cost;
    if (cost > 0 && r.session) {
      const key = `${target}\0${r.session.replace(/^ext:/, '')}`;
      characterSessions.set(key, (characterSessions.get(key) ?? 0) + cost);
    } else if (cost > 0) unkeyedCharacters += cost;
    if (!session) {
      unkeyedInjectedItems += ids(r.idsInjected).length;
      continue;
    }
    if (r.ok && !r.failOpen && r.surface === 'hook') {
      for (const id of ids(r.idsInjected)) {
        const key = `${target}\0${session}\0${id}\0${surface}`;
        const before = exposures.get(key);
        if (!before || time < before.time)
          exposures.set(key, { target, session, id, time, surface });
        const itemKey = `${target}\0${id}`;
        const item = itemSessions.get(itemKey) ?? {
          target,
          id,
          sessions: new Set<string>(),
          used: false,
        };
        item.sessions.add(session);
        itemSessions.set(itemKey, item);
      }
    }
    if (r.ok && !r.refused && !r.failOpen) {
      const shown =
        r.action === 'show' && /^cmos_(decisions|learnings)$/.test(r.tool)
          ? ids(r.idsReturned)
          : [];
      const cited = r.mode === 'write' ? ids(r.idsCited) : [];
      for (const id of new Set([...shown, ...cited])) {
        const key = `${target}\0${session}\0${id}`;
        const times = uses.get(key) ?? [];
        times.push(time);
        uses.set(key, times);
      }
    }
    if (r.ok && !r.failOpen && surface === 'digest' && r.digestHash && cost > 0) {
      const key = `${target}\0${new Date(time).toISOString().slice(0, 10)}`;
      const day = digestDays.get(key) ?? new Map<string, { time: number; hash: string }>();
      if (!day.has(session) || day.get(session)!.time < time)
        day.set(session, { time, hash: r.digestHash });
      digestDays.set(key, day);
    }
  }
  const totals = {
    digest: { injected: 0, used: 0 },
    prompt: { injected: 0, used: 0 },
    other: { injected: 0, used: 0 },
  };
  for (const e of exposures.values()) {
    totals[e.surface].injected++;
    if ((uses.get(`${e.target}\0${e.session}\0${e.id}`) ?? []).some((time) => time > e.time)) {
      totals[e.surface].used++;
      itemSessions.get(`${e.target}\0${e.id}`)!.used = true;
    }
  }
  const rate = (surface: Surface) => ({
    ...totals[surface],
    ratio: ratio(totals[surface].used, totals[surface].injected),
  });
  let stableDigestSessions = 0;
  let comparableDigestSessions = 0;
  for (const sessions of digestDays.values()) {
    if (sessions.size < 2) continue;
    comparableDigestSessions += sessions.size;
    const hashes = new Map<string, number>();
    for (const { hash } of sessions.values()) hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
    for (const count of hashes.values()) if (count >= 2) stableDigestSessions += count;
  }
  const comparison = (ambient: 'on' | 'digest-off') => {
    const records = prompts.filter(({ record }) => record.ambient === ambient);
    const measured = records.filter(
      ({ record }) => Array.isArray(record.restatedRuleIds) && !record.ruleReadFailed
    );
    const restated = measured.filter(({ record }) => record.restatedRuleIds!.length > 0).length;
    return {
      prompts: records.length,
      measuredPrompts: measured.length,
      restatedPrompts: restated,
      restatementRatio: ratio(restated, measured.length),
    };
  };
  return {
    records: all.length,
    prompting: {
      status: measuredPrompts.length > 0 ? ('observed' as const) : ('unavailable' as const),
      prompts: prompts.length,
      measuredPrompts: measuredPrompts.length,
      unmeasuredPrompts: prompts.length - measuredPrompts.length,
      prompted: measuredPrompts.filter(
        ({ record }) =>
          record.procedurePatternIds!.length > 0 && !isCeremonyCommand(record.ceremony ?? null)
      ).length,
      pluginCeremonies: prompts.filter(({ record }) => isCeremonyCommand(record.ceremony ?? null))
        .length,
      sentenceCeremonies: prompts.filter(({ record }) => /^C\d+$/.test(record.ceremony ?? ''))
        .length,
    },
    citeThrough: {
      digest: rate('digest'),
      prompt: rate('prompt'),
      other: rate('other'),
      unkeyedInjectedItems,
    },
    repeatedNeverCited: {
      minimumSessions: 2,
      items: [...itemSessions.values()]
        .filter((item) => item.sessions.size >= 2 && !item.used)
        .map((item) => ({ target: item.target, id: item.id, sessions: item.sessions.size })),
    },
    restatement: {
      measuredPrompts: restatementPrompts.length,
      restatedPrompts,
      unmeasuredPrompts: prompts.length - restatementPrompts.length,
      per100: restatementPrompts.length
        ? (100 * restatedPrompts) / restatementPrompts.length
        : null,
    },
    injection: {
      characters,
      sessions: characterSessions.size,
      meanCharactersPerSession: ratio(characters - unkeyedCharacters, characterSessions.size),
      unkeyedCharacters,
      charactersBySurface,
      stableDigestSessions,
      comparableDigestSessions,
      stableDigestRatio: ratio(stableDigestSessions, comparableDigestSessions),
    },
    injectionSessions: [...characterSessions].map(([key, chars]) => {
      const [target, session] = key.split('\0');
      return { target, session, characters: chars };
    }),
    digestOff: {
      status: 'deferred-observational' as const,
      on: comparison('on'),
      off: comparison('digest-off'),
    },
    safety: {
      deadlineMisses: all.filter(({ record }) => record.failOpen === 'deadline').length,
      failOpens: all.filter(({ record }) => Boolean(record.failOpen)).length,
      refusals: all.filter(({ record }) => Boolean(record.refused)).length,
      failedCalls: all.filter(({ record }) => !record.ok).length,
    },
  };
}
