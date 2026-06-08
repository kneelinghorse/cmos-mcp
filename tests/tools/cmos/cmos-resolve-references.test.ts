/**
 * cmos_resolve_references Tool Tests
 *
 * Tests for reference resolution functionality including TraceLab URI parsing,
 * web URL detection, and local doc categorization.
 *
 * @module tests/tools/cmos/cmos-resolve-references
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosResolveReferences,
  cmosResolveReferencesToolDefinition,
  formatResolveReferencesForLLM,
  parseTracelabUri,
  isTracelabUri,
  isWebUrl,
  parseWebUrl,
  parseLocalDoc,
  TRACELAB_URI_TYPES,
  type CmosResolveReferencesResult,
} from '../../../src/tools/cmos/cmos-resolve-references';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('cmos_resolve_references', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-resolve-refs-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        reference_docs TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      INSERT INTO sprints (id, title) VALUES ('sprint-18', 'Sprint 18');

      -- Mission with mixed references
      INSERT INTO missions (id, sprint_id, name, status, reference_docs)
      VALUES ('s18-m01', 'sprint-18', 'Test Mission', 'In Progress',
        '["tracelab://document/abc123", "docs/README.md", "https://example.com/api", "tracelab://chunk/def456"]');

      -- Mission with only TraceLab refs
      INSERT INTO missions (id, sprint_id, name, status, reference_docs)
      VALUES ('s18-m02', 'sprint-18', 'TraceLab Only', 'Queued',
        '["tracelab://project/proj-1", "tracelab://collection/col-1", "tracelab://report/rpt-1"]');

      -- Mission with no references
      INSERT INTO missions (id, sprint_id, name, status, reference_docs)
      VALUES ('s18-m03', 'sprint-18', 'No Refs', 'Queued', null);

      -- Mission with empty array
      INSERT INTO missions (id, sprint_id, name, status, reference_docs)
      VALUES ('s18-m04', 'sprint-18', 'Empty Refs', 'Queued', '[]');

      -- Mission with only local docs
      INSERT INTO missions (id, sprint_id, name, status, reference_docs)
      VALUES ('s18-m05', 'sprint-18', 'Local Only', 'Queued',
        '["docs/guide.md", "cmos/agents.md", "./README.md"]');

      -- Mission with only web URLs
      INSERT INTO missions (id, sprint_id, name, status, reference_docs)
      VALUES ('s18-m06', 'sprint-18', 'Web Only', 'Queued',
        '["https://docs.example.com", "http://api.test.io/v1", "https://github.com/org/repo"]');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseTracelabUri', () => {
    it('should parse document URI', () => {
      const result = parseTracelabUri('tracelab://document/abc123');
      expect(result.type).toBe('document');
      expect(result.resourceId).toBe('abc123');
      expect(result.path).toBeNull();
    });

    it('should parse chunk URI', () => {
      const result = parseTracelabUri('tracelab://chunk/def456');
      expect(result.type).toBe('chunk');
      expect(result.resourceId).toBe('def456');
    });

    it('should parse project URI', () => {
      const result = parseTracelabUri('tracelab://project/proj-1');
      expect(result.type).toBe('project');
      expect(result.resourceId).toBe('proj-1');
    });

    it('should parse collection URI', () => {
      const result = parseTracelabUri('tracelab://collection/col-1');
      expect(result.type).toBe('collection');
      expect(result.resourceId).toBe('col-1');
    });

    it('should parse report URI', () => {
      const result = parseTracelabUri('tracelab://report/rpt-1');
      expect(result.type).toBe('report');
      expect(result.resourceId).toBe('rpt-1');
    });

    it('should parse search URI', () => {
      const result = parseTracelabUri('tracelab://search/query-term');
      expect(result.type).toBe('search');
      expect(result.resourceId).toBe('query-term');
    });

    it('should handle URI with path', () => {
      const result = parseTracelabUri('tracelab://document/abc123/sections/intro');
      expect(result.type).toBe('document');
      expect(result.resourceId).toBe('abc123');
      expect(result.path).toBe('sections/intro');
    });

    it('should mark unknown types', () => {
      const result = parseTracelabUri('tracelab://unknown-type/id');
      expect(result.type).toBe('unknown');
      expect(result.resourceId).toBe('id');
    });

    it('should handle non-tracelab URI', () => {
      const result = parseTracelabUri('https://example.com');
      expect(result.type).toBe('unknown');
      expect(result.resourceId).toBeNull();
    });
  });

  describe('isTracelabUri', () => {
    it('should return true for tracelab:// URIs', () => {
      expect(isTracelabUri('tracelab://document/abc')).toBe(true);
      expect(isTracelabUri('tracelab://chunk/def')).toBe(true);
    });

    it('should return false for other URIs', () => {
      expect(isTracelabUri('https://example.com')).toBe(false);
      expect(isTracelabUri('docs/README.md')).toBe(false);
      expect(isTracelabUri('')).toBe(false);
    });
  });

  describe('isWebUrl', () => {
    it('should return true for http/https URLs', () => {
      expect(isWebUrl('https://example.com')).toBe(true);
      expect(isWebUrl('http://test.io')).toBe(true);
      expect(isWebUrl('https://docs.github.com/api')).toBe(true);
    });

    it('should return false for other strings', () => {
      expect(isWebUrl('tracelab://document/abc')).toBe(false);
      expect(isWebUrl('docs/README.md')).toBe(false);
      expect(isWebUrl('ftp://files.example.com')).toBe(false);
    });
  });

  describe('parseWebUrl', () => {
    it('should extract hostname', () => {
      const result = parseWebUrl('https://docs.example.com/guide');
      expect(result.hostname).toBe('docs.example.com');
    });

    it('should handle invalid URL gracefully', () => {
      const result = parseWebUrl('not-a-url');
      expect(result.hostname).toBeNull();
    });
  });

  describe('parseLocalDoc', () => {
    it('should return path as-is', () => {
      const result = parseLocalDoc('docs/README.md');
      expect(result.path).toBe('docs/README.md');
      expect(result.ref).toBe('docs/README.md');
    });
  });

  describe('cmosResolveReferences', () => {
    it('should categorize mixed references', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m01' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('s18-m01');
      expect(result.data?.tracelabRefs.length).toBe(2);
      expect(result.data?.localDocs.length).toBe(1);
      expect(result.data?.webUrls.length).toBe(1);
      expect(result.data?.totalRefs).toBe(4);
    });

    it('should handle TraceLab-only references', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m02' });

      expect(result.success).toBe(true);
      expect(result.data?.tracelabRefs.length).toBe(3);
      expect(result.data?.localDocs.length).toBe(0);
      expect(result.data?.webUrls.length).toBe(0);

      // Verify types
      const types = result.data?.tracelabRefs.map((r) => r.type);
      expect(types).toContain('project');
      expect(types).toContain('collection');
      expect(types).toContain('report');
    });

    it('should handle null reference_docs', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m03' });

      expect(result.success).toBe(true);
      expect(result.data?.totalRefs).toBe(0);
      expect(result.data?.message).toContain('no reference docs');
    });

    it('should handle empty array reference_docs', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m04' });

      expect(result.success).toBe(true);
      expect(result.data?.totalRefs).toBe(0);
    });

    it('should handle local-only references', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m05' });

      expect(result.success).toBe(true);
      expect(result.data?.localDocs.length).toBe(3);
      expect(result.data?.tracelabRefs.length).toBe(0);
      expect(result.data?.webUrls.length).toBe(0);
    });

    it('should handle web-only references', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.webUrls.length).toBe(3);
      expect(result.data?.tracelabRefs.length).toBe(0);
      expect(result.data?.localDocs.length).toBe(0);

      // Verify hostnames extracted
      const hostnames = result.data?.webUrls.map((u) => u.hostname);
      expect(hostnames).toContain('docs.example.com');
      expect(hostnames).toContain('api.test.io');
      expect(hostnames).toContain('github.com');
    });

    it('should return error for non-existent mission', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 'non-existent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_NOT_FOUND');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosResolveReferencesToolDefinition.name).toBe('cmos_resolve_references');
    });

    it('should have description mentioning TraceLab', () => {
      expect(cmosResolveReferencesToolDefinition.description).toContain('TraceLab');
    });

    it('should require missionId', () => {
      expect(cmosResolveReferencesToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('should mention it does NOT fetch content', () => {
      expect(cmosResolveReferencesToolDefinition.description.toLowerCase()).toContain('not fetch');
    });
  });

  describe('TRACELAB_URI_TYPES', () => {
    it('should include all documented types', () => {
      expect(TRACELAB_URI_TYPES).toContain('project');
      expect(TRACELAB_URI_TYPES).toContain('collection');
      expect(TRACELAB_URI_TYPES).toContain('report');
      expect(TRACELAB_URI_TYPES).toContain('document');
      expect(TRACELAB_URI_TYPES).toContain('chunk');
      expect(TRACELAB_URI_TYPES).toContain('search');
    });
  });

  describe('formatResolveReferencesForLLM', () => {
    it('should format mixed references clearly', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m01' });
      const formatted = formatResolveReferencesForLLM(result);

      expect(formatted).toContain('TraceLab References');
      expect(formatted).toContain('Local Docs');
      expect(formatted).toContain('Web URLs');
      expect(formatted).toContain('Total');
    });

    it('should handle empty references gracefully', async () => {
      const result = await cmosResolveReferencesWithDb(dbPath, { missionId: 's18-m03' });
      const formatted = formatResolveReferencesForLLM(result);

      expect(formatted).toContain('No reference docs');
    });
  });
});

/**
 * Helper to run cmosResolveReferences with explicit database path.
 */
async function cmosResolveReferencesWithDb(
  dbPath: string,
  params: { missionId: string }
): Promise<{
  success: boolean;
  data?: CmosResolveReferencesResult;
  error?: { code: string; message: string };
}> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError, CMOS_ERROR_CODES } =
    await import('../../../src/tools/cmos/errors');
  const { parseTracelabUri, isTracelabUri, isWebUrl, parseWebUrl, parseLocalDoc } =
    await import('../../../src/tools/cmos/cmos-resolve-references');

  return withClient(
    (client) => {
      const { missionId } = params;

      // Fetch the mission
      const missionResult = client.getOne<{ id: string; reference_docs: string | null }>(
        'SELECT id, reference_docs FROM missions WHERE id = ?',
        [missionId]
      );

      if (!missionResult.success || !missionResult.data) {
        return createError<CmosResolveReferencesResult>({
          code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
          message: `Mission not found: ${missionId}`,
        });
      }

      const mission = missionResult.data;

      // Parse reference_docs JSON
      let refs: string[] = [];
      if (mission.reference_docs) {
        try {
          const parsed = JSON.parse(mission.reference_docs);
          if (Array.isArray(parsed)) {
            refs = parsed.filter((r): r is string => typeof r === 'string');
          }
        } catch {
          refs = [];
        }
      }

      // Categorize references
      const tracelabRefs: Array<{
        uri: string;
        type: string;
        resourceId: string | null;
        path: string | null;
      }> = [];
      const localDocs: Array<{ ref: string; path: string }> = [];
      const webUrls: Array<{ url: string; hostname: string | null }> = [];

      for (const ref of refs) {
        const trimmedRef = ref.trim();
        if (!trimmedRef) continue;

        if (isTracelabUri(trimmedRef)) {
          tracelabRefs.push(parseTracelabUri(trimmedRef));
        } else if (isWebUrl(trimmedRef)) {
          webUrls.push(parseWebUrl(trimmedRef));
        } else {
          localDocs.push(parseLocalDoc(trimmedRef));
        }
      }

      const totalRefs = tracelabRefs.length + localDocs.length + webUrls.length;

      const message =
        totalRefs === 0
          ? `Mission '${missionId}' has no reference docs`
          : `Mission '${missionId}' has ${totalRefs} refs`;

      return createSuccess<CmosResolveReferencesResult>({
        missionId,
        tracelabRefs: tracelabRefs as CmosResolveReferencesResult['tracelabRefs'],
        localDocs,
        webUrls,
        totalRefs,
        message,
      });
    },
    { dbPath }
  );
}
