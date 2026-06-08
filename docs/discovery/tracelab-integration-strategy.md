# TraceLab Integration Strategy

**Mission**: s15-m03
**Date**: 2025-12-27
**Status**: Complete

## Executive Summary

TraceLab and CMOS serve complementary roles in the research-to-build pipeline:

- **TraceLab**: Research knowledge management (documents, search, synthesis)
- **CMOS**: Build project management (missions, sprints, context)

This document defines a practical integration strategy that connects research findings to build decisions with full traceability.

---

## 1. System Overview

### TraceLab Capabilities

| Component   | Purpose                    | Data Model                    |
| ----------- | -------------------------- | ----------------------------- |
| Projects    | Organize research topics   | UUID, name, type, status      |
| Documents   | Store source materials     | PDF, DOCX, MD, JSON uploaded  |
| Chunks      | Indexed content for search | Semantic vectors, tags        |
| Collections | Curated chunk groups       | Named groupings for synthesis |
| Reports     | Synthesized outputs        | Generated from collections    |
| Missions    | DeepSearch research tasks  | Objective, criteria, depth    |

### CMOS Capabilities

| Component | Purpose                 | Data Model                        |
| --------- | ----------------------- | --------------------------------- |
| Sprints   | Organize build phases   | ID, title, focus, dates           |
| Missions  | Build work units        | Objective, criteria, deliverables |
| Sessions  | Planning/review capture | Type, captures, summary           |
| Contexts  | Project memory          | Master/project context            |
| Decisions | Strategic choices       | Decision text, domain, sprint     |

### Integration Vision

```
┌─────────────────────────────────────────────────────────────────┐
│                     RESEARCH PHASE                               │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │Documents │ → │ Chunks   │ → │Collections│ → │ Reports  │   │
│  │(Sources) │    │(Indexed) │    │(Curated) │    │(Insights)│   │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘   │
│       TraceLab Projects                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ cross-reference
┌─────────────────────────────────────────────────────────────────┐
│                      BUILD PHASE                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │ Sprints  │ → │ Missions │ → │ Sessions │ → │ Decisions│   │
│  │(Phases)  │    │(Work)    │    │(Captures)│    │(Strategic)│   │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘   │
│       CMOS Database                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Integration Points

### 2.1 Project-Level Linking

**Goal**: Connect TraceLab projects to CMOS sprints/projects.

**Approach**: Add `tracelab_project_id` field to CMOS metadata.

```sql
-- In CMOS metadata table
INSERT INTO metadata (key, value) VALUES
('tracelab_project_id', 'ef13d67b-3f19-4d19-8c69-f689becd29c9');
```

**Usage**:

- Agent onboard includes TraceLab project reference
- Research searches scoped to linked project
- Cross-system navigation possible

### 2.2 Mission Reference Linking

**Goal**: CMOS missions reference TraceLab research as source material.

**Approach**: Use `reference_docs` field with TraceLab URIs.

```yaml
mission:
  id: 's15-m03'
  reference_docs:
    - 'tracelab://project/ef13d67b/collection/4fd225c7'
    - 'tracelab://report/bec8d89e'
    - 'tracelab://search?q=integration+patterns'
```

**URI Schema**:

```
tracelab://project/{project_id}
tracelab://project/{project_id}/collection/{collection_id}
tracelab://report/{report_id}
tracelab://document/{document_id}
tracelab://chunk/{chunk_id}
tracelab://search?q={query}&project={project_id}
```

### 2.3 Decision Provenance

**Goal**: Link CMOS strategic decisions to TraceLab evidence.

**Approach**: Add `source_chunk_ids` to strategic_decisions.

```sql
-- Extend strategic_decisions schema
ALTER TABLE strategic_decisions ADD COLUMN source_chunk_ids TEXT;
-- JSON array of TraceLab chunk IDs that informed this decision
```

**Example**:

```json
{
  "decision": "Use event sourcing for audit trail",
  "source_chunk_ids": ["abc123", "def456"],
  "evidence_summary": "TraceLab research on CQRS patterns"
}
```

### 2.4 Context Enrichment

**Goal**: CMOS master_context includes relevant TraceLab findings.

**Approach**: Add `research_references` section to context.

```json
{
  "master_context": {
    "research_references": {
      "tracelab_project": "ef13d67b-...",
      "key_reports": [
        {
          "id": "bec8d89e-...",
          "title": "IoT Domain Analysis",
          "relevance": "Informs device management architecture"
        }
      ],
      "active_collections": ["56d4fa4e-..."]
    }
  }
}
```

---

## 3. Workflow Integration

### 3.1 Research Reference Workflow

**Scenario**: Agent needs research context before starting build mission.

```
1. Agent calls cmos_mission_show(missionId="s15-m03")
   → Gets reference_docs with TraceLab URIs

2. Agent parses TraceLab URIs and calls:
   → tracelab_get_report(report_id="...")
   → tracelab_search_knowledge(query="...", project_id="...")

3. Agent has full research context for build work
```

**New CMOS Tool**: `cmos_resolve_references`

```typescript
{
  name: "cmos_resolve_references",
  parameters: {
    missionId: string
  },
  returns: {
    localDocs: string[],        // File paths
    tracelabReports: Report[],  // Fetched report content
    tracelabChunks: Chunk[],    // Relevant search results
    webUrls: string[]           // External URLs
  }
}
```

### 3.2 Document Storage Workflow

**Scenario**: Research documents need persistent storage with full-text search.

**Approach**: TraceLab is the document store, CMOS references.

```
1. Research phase:
   → Upload documents to TraceLab project
   → Documents automatically chunked and indexed

2. Reference in CMOS:
   → Add tracelab://document/{id} to mission reference_docs

3. Search during build:
   → tracelab_search_knowledge(query, project_id)
   → Returns relevant chunks with document provenance
```

**Benefits**:

- No duplicate document storage in CMOS
- Semantic search across all research
- Full-text search via TraceLab indexing
- Version control via TraceLab

### 3.3 Session Capture → TraceLab

**Scenario**: CMOS session captures research insights that should persist in TraceLab.

**Approach**: Export session captures to TraceLab collection.

```
1. During CMOS session:
   → cmos_session_capture(category="insight", content="...")

2. On session complete:
   → Option to export captures to TraceLab collection
   → Creates collection in linked TraceLab project

3. Future reference:
   → Insights searchable via TraceLab
   → Original session ID preserved as metadata
```

**New CMOS Tool**: `cmos_session_export_to_tracelab`

```typescript
{
  name: "cmos_session_export_to_tracelab",
  parameters: {
    sessionId: string,
    tracelabProjectId: string,
    collectionName?: string  // Default: "CMOS Session: {title}"
  }
}
```

---

## 4. Implementation Recommendations

### Phase 1: Schema Extensions (Sprint 16)

1. **Add tracelab_project_id to metadata**

   ```sql
   INSERT INTO metadata (key, value) VALUES
   ('tracelab_project_id', NULL);
   ```

2. **Document reference_docs URI convention**
   - Update agents.md with TraceLab URI format
   - Add examples to mission templates

3. **Add source_chunk_ids to strategic_decisions**
   ```sql
   ALTER TABLE strategic_decisions
   ADD COLUMN source_chunk_ids TEXT;
   ```

### Phase 2: Cross-Reference Tools (Sprint 17)

4. **Implement cmos_resolve_references**
   - Parse reference_docs for TraceLab URIs
   - Fetch content via TraceLab MCP tools
   - Return unified reference payload

5. **Enhance cmos_agent_onboard**
   - Include tracelab_project_id
   - Suggest relevant TraceLab searches

### Phase 3: Bidirectional Sync (Sprint 18)

6. **Implement cmos_session_export_to_tracelab**
   - Export session captures as TraceLab collection
   - Preserve CMOS session metadata

7. **Add TraceLab → CMOS import**
   - Import TraceLab report as CMOS context update
   - Link report ID to mission that used it

---

## 5. Agent Workflow Examples

### Example 1: Starting Research-Informed Build

```
Agent: Starting mission s15-m03

1. cmos_mission_show("s15-m03")
   → reference_docs: ["tracelab://report/bec8d89e"]

2. tracelab_get_report("bec8d89e")
   → Returns: "IoT Domain Analysis report content..."

3. Agent now has research context for build decisions
```

### Example 2: Capturing Decision with Evidence

```
Agent: Making architectural decision

1. tracelab_search_knowledge("event sourcing patterns")
   → Returns chunks: [chunk_abc, chunk_def]

2. cmos_session_capture(
     category="decision",
     content="Use event sourcing for audit trail",
     context="Based on TraceLab research chunks abc, def"
   )

3. Decision recorded with research provenance
```

### Example 3: Research Synthesis → Build Planning

```
Agent: Planning sprint from research

1. tracelab_list_collections(project_id="...")
   → Returns relevant research collections

2. tracelab_synthesize(collection_id="...")
   → Returns synthesis of research findings

3. cmos_sprint_add(
     sprintId="sprint-16",
     title="Implement research findings",
     focus="{synthesis summary}"
   )

4. Sprint created from research insights
```

---

## 6. Data Flow Diagram

```
┌─────────────────┐     upload      ┌─────────────────┐
│  Source Docs    │ ───────────────▶│    TraceLab     │
│  (PDFs, MD)     │                 │    Documents    │
└─────────────────┘                 └────────┬────────┘
                                             │ chunk
                                             ▼
                                    ┌─────────────────┐
                                    │    TraceLab     │
                                    │     Chunks      │
                                    └────────┬────────┘
                                             │ curate
                                             ▼
                                    ┌─────────────────┐
                                    │    TraceLab     │
                                    │   Collections   │
                                    └────────┬────────┘
                                             │ synthesize
                                             ▼
                                    ┌─────────────────┐
                                    │    TraceLab     │◀──────┐
                                    │     Reports     │       │
                                    └────────┬────────┘       │
                                             │                │
              reference_docs                 │                │
┌─────────────────┐◀────────────────────────┘                │
│      CMOS       │                                          │
│    Missions     │                                          │
└────────┬────────┘                                          │
         │ session captures                                  │
         ▼                                                   │
┌─────────────────┐                                          │
│      CMOS       │ ─────────────────────────────────────────┘
│    Sessions     │        export to collection
└────────┬────────┘
         │ aggregate
         ▼
┌─────────────────┐
│      CMOS       │
│    Decisions    │ ← source_chunk_ids link back to TraceLab
└─────────────────┘
```

---

## 7. Success Criteria

- [ ] Agent can access TraceLab research from CMOS mission context
- [ ] Decisions reference TraceLab evidence via source_chunk_ids
- [ ] Session captures exportable to TraceLab collections
- [ ] Agent onboard includes TraceLab project reference
- [ ] Research → Build traceability queryable
- [ ] No duplicate document storage between systems

---

## Appendix: TraceLab MCP Tool Reference

### Search & Discovery

- `search_knowledge(query, project_id?, tags?)` - Semantic search
- `list_projects()` - Browse projects
- `get_project_stats(project_id)` - Project metrics

### Document Management

- `upload_document(name, content, content_type, project_id)` - Add document
- `get_document_content(document_id)` - Read document

### Collections & Synthesis

- `create_collection(name, description?)` - New collection
- `add_to_collection(collection_id, chunk_id, notes?)` - Add chunk
- `synthesize(collection_id, prompt?, format?)` - Generate synthesis
- `create_report(title, collection_id?, chunk_ids?)` - Create report

### Research Missions (DeepSearch)

- `create_mission(mission_id, title, objective, ...)` - New research mission
- `submit_mission(mission_id, research_depth?)` - Execute research
- `get_mission_status(mission_id)` - Check progress
