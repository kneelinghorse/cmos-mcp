# Research-to-Build Traceability Model

**Mission**: s15-m03
**Date**: 2025-12-27
**Status**: Complete

## Overview

This document defines the traceability model connecting research activities in TraceLab to build activities in CMOS, enabling:

- **Forward traceability**: Research → Decisions → Implementation
- **Backward traceability**: Implementation → Decisions → Research evidence

---

## 1. Traceability Chain

### The Research-to-Build Pipeline

```
Research Question                    Build Deliverable
       │                                    ▲
       ▼                                    │
┌──────────────┐                   ┌──────────────┐
│  TraceLab    │                   │     CMOS     │
│   Mission    │                   │   Mission    │
│  (research)  │                   │   (build)    │
└──────┬───────┘                   └──────▲───────┘
       │                                  │
       ▼                                  │
┌──────────────┐                   ┌──────────────┐
│   Source     │                   │   Sprint     │
│  Documents   │                   │   Planning   │
└──────┬───────┘                   └──────▲───────┘
       │                                  │
       ▼                                  │
┌──────────────┐                   ┌──────────────┐
│   Indexed    │                   │   Strategic  │
│    Chunks    │                   │   Decisions  │
└──────┬───────┘                   └──────▲───────┘
       │                                  │
       ▼                                  │
┌──────────────┐     synthesize    ┌──────────────┐
│  Collection  │ ─────────────────▶│    Report    │
│  (curated)   │                   │  (insights)  │
└──────────────┘                   └──────────────┘
```

### Traceability Links

| From             | To                 | Link Type        | Storage               |
| ---------------- | ------------------ | ---------------- | --------------------- |
| TraceLab Mission | TraceLab Documents | contains         | TraceLab DB           |
| Document         | Chunks             | derived_from     | TraceLab DB           |
| Chunks           | Collection         | member_of        | TraceLab DB           |
| Collection       | Report             | synthesized_into | TraceLab DB           |
| Report           | CMOS Mission       | referenced_by    | CMOS reference_docs   |
| Chunks           | CMOS Decision      | evidence_for     | CMOS source_chunk_ids |
| CMOS Decision    | CMOS Mission       | informs          | CMOS notes/context    |
| CMOS Mission     | Deliverable        | produces         | CMOS deliverables     |

---

## 2. Traceability Identifiers

### TraceLab Identifiers

```
Project ID:    UUID (e.g., "ef13d67b-3f19-4d19-8c69-f689becd29c9")
Document ID:   UUID
Chunk ID:      UUID
Collection ID: UUID
Report ID:     UUID
Mission ID:    User-defined string (e.g., "IOT-R1-DEEP")
```

### CMOS Identifiers

```
Sprint ID:     User-defined (e.g., "sprint-15")
Mission ID:    User-defined (e.g., "s15-m03")
Session ID:    Generated (e.g., "PS-2025-12-27-001")
Decision ID:   Auto-increment integer
Snapshot ID:   Auto-increment integer
```

### Cross-Reference URI Schema

```
tracelab://project/{project_id}
tracelab://document/{document_id}
tracelab://chunk/{chunk_id}
tracelab://collection/{collection_id}
tracelab://report/{report_id}
tracelab://mission/{mission_id}
tracelab://search?q={query}&project={project_id}

cmos://sprint/{sprint_id}
cmos://mission/{mission_id}
cmos://session/{session_id}
cmos://decision/{decision_id}
cmos://context/{context_type}
```

---

## 3. Traceability Data Model

### Extended CMOS Schema

```sql
-- Add to strategic_decisions
ALTER TABLE strategic_decisions ADD COLUMN source_chunk_ids TEXT;
-- JSON array: ["chunk-uuid-1", "chunk-uuid-2"]

ALTER TABLE strategic_decisions ADD COLUMN tracelab_report_id TEXT;
-- UUID of synthesizing report

-- Add to missions
ALTER TABLE missions ADD COLUMN tracelab_references TEXT;
-- JSON object: {
--   "project_id": "uuid",
--   "collection_ids": ["uuid", "uuid"],
--   "report_ids": ["uuid"],
--   "chunk_ids": ["uuid"]
-- }

-- Add to metadata (project-level)
INSERT INTO metadata (key, value) VALUES
('tracelab_project_id', NULL),
('tracelab_sync_enabled', 'false');
```

### Traceability Record

For each traceable decision, store:

```json
{
  "decision_id": 42,
  "decision_text": "Use event sourcing for audit trail",
  "created_at": "2025-12-27T10:00:00Z",
  "sprint_id": "sprint-15",
  "mission_id": "s15-m03",
  "traceability": {
    "source_chunks": [
      {
        "chunk_id": "abc123",
        "document_id": "doc456",
        "document_name": "CQRS Patterns Research.pdf",
        "relevance_score": 0.92,
        "excerpt": "Event sourcing provides complete audit..."
      }
    ],
    "synthesizing_report": {
      "report_id": "rpt789",
      "title": "Architecture Patterns Analysis",
      "created_at": "2025-12-26T15:00:00Z"
    },
    "tracelab_project": "ef13d67b-..."
  }
}
```

---

## 4. Traceability Workflows

### 4.1 Forward Traceability: Research → Build

**Goal**: Trace how research informed build decisions.

```
Step 1: Identify research mission
        TraceLab Mission: "IOT-R1-DEEP"

Step 2: Find collected evidence
        → Collection: "IoT/Device Management Domain Research"
        → 10 chunks from 5 source documents

Step 3: Locate synthesis
        → Report: "IoT/Device Management — OODS Domain Analysis"

Step 4: Find referencing CMOS missions
        → CMOS Mission: "s16-m02"
        → reference_docs: ["tracelab://report/bec8d89e"]

Step 5: Find resulting decisions
        → Decision: "Use device twin pattern for state sync"
        → source_chunk_ids: ["chunk-abc", "chunk-def"]

Step 6: Find implementation
        → CMOS Mission deliverables: ["src/device/twin.ts"]
```

**Query Path**:

```
TraceLab Mission → Collection → Report
       ↓
CMOS Mission (reference_docs) → Decision (source_chunk_ids)
       ↓
Deliverables
```

### 4.2 Backward Traceability: Build → Research

**Goal**: Trace why a decision was made.

```
Step 1: Identify decision
        Decision: "Use device twin pattern for state sync"

Step 2: Find evidence
        → source_chunk_ids: ["chunk-abc", "chunk-def"]

Step 3: Retrieve chunks
        → tracelab_get_document_content("doc456")
        → Original research document with highlighted passages

Step 4: Find research context
        → Collection: "IoT/Device Management Domain Research"
        → TraceLab Mission: "IOT-R1-DEEP"
        → Research objective: "Analyze IoT platform patterns"

Step 5: Understand research scope
        → 10 chunks, 5 documents, 1 synthesis report
        → Research depth: DEEP
        → Completed: 2025-12-19
```

**Query Path**:

```
Decision.source_chunk_ids → TraceLab Chunks → Documents
       ↓
Collection → TraceLab Mission → Research Objective
```

### 4.3 Gap Analysis: Missing Evidence

**Goal**: Identify decisions without research backing.

```
SELECT d.id, d.decision_text, d.created_at
FROM strategic_decisions d
WHERE d.source_chunk_ids IS NULL
  AND d.created_at > date('now', '-30 days')
ORDER BY d.created_at DESC;
```

Returns decisions made without TraceLab evidence, flagging:

- Decisions based on intuition (may need validation)
- Decisions from external sources (need documentation)
- Rapid decisions (may need post-hoc research)

---

## 5. Implementation Guide

### 5.1 Capturing Evidence During Research

**When conducting research in TraceLab**:

1. Create focused collection for research theme
2. Add relevant chunks with notes explaining relevance
3. Synthesize into report with key findings
4. Export report ID for CMOS reference

```
# During research session
tracelab_create_collection(
  name="s15-m03 Research: TraceLab Integration",
  description="Evidence for CMOS-TraceLab integration strategy"
)

tracelab_add_to_collection(
  collection_id="...",
  chunk_id="...",
  notes="Key pattern for bidirectional sync"
)

tracelab_create_report(
  title="Integration Strategy Evidence",
  collection_id="..."
)
```

### 5.2 Linking Research to Build

**When starting CMOS build mission**:

1. Add TraceLab report URIs to reference_docs
2. During session, capture decisions with chunk references
3. On session complete, verify evidence links

```yaml
# In CMOS mission spec
mission:
  id: 's16-m02'
  reference_docs:
    - 'tracelab://report/bec8d89e'
    - 'tracelab://collection/56d4fa4e'
  tracelab_references:
    project_id: 'ef13d67b-...'
    report_ids: ['bec8d89e']
```

### 5.3 Recording Decisions with Evidence

**When making strategic decision**:

```python
# Via CMOS CLI
./cmos/cli.py session capture decision \
  "Use device twin pattern for state sync" \
  --context "Based on TraceLab chunks abc, def from IoT research"

# Extended capture with structured evidence
cmos_session_capture(
  category="decision",
  content="Use device twin pattern for state sync",
  context=json.dumps({
    "source_chunk_ids": ["chunk-abc", "chunk-def"],
    "tracelab_report_id": "bec8d89e",
    "confidence": "high"
  })
)
```

### 5.4 Verifying Traceability

**At sprint completion**:

```
# Check decision coverage
decisions_without_evidence = query("""
  SELECT * FROM strategic_decisions
  WHERE sprint_id = 'sprint-15'
    AND source_chunk_ids IS NULL
""")

# Generate traceability report
for decision in decisions_with_evidence:
    chunks = tracelab_get_chunks(decision.source_chunk_ids)
    print(f"Decision: {decision.text}")
    print(f"Evidence: {len(chunks)} chunks from {len(documents)} docs")
```

---

## 6. Traceability Queries

### Query 1: All evidence for a mission

```sql
-- Get all TraceLab references for a CMOS mission
SELECT
  m.id as mission_id,
  m.name as mission_name,
  m.tracelab_references,
  m.reference_docs
FROM missions m
WHERE m.id = 's15-m03';
```

### Query 2: Decisions by evidence strength

```sql
-- Rank decisions by evidence support
SELECT
  d.id,
  d.decision_text,
  json_array_length(d.source_chunk_ids) as evidence_count,
  d.sprint_id
FROM strategic_decisions d
WHERE d.source_chunk_ids IS NOT NULL
ORDER BY evidence_count DESC;
```

### Query 3: Research utilization

```sql
-- Find which TraceLab reports are referenced
SELECT
  m.id,
  m.reference_docs
FROM missions m
WHERE m.reference_docs LIKE '%tracelab://%'
ORDER BY m.id;
```

### Query 4: Orphan research (unused)

TraceLab query to find collections never referenced in CMOS:

```
# List collections, cross-reference with CMOS reference_docs
# Collections not appearing in any CMOS mission are orphans
```

---

## 7. Traceability Metrics

### Coverage Metrics

| Metric                 | Definition                            | Target |
| ---------------------- | ------------------------------------- | ------ |
| Decision Evidence Rate | % decisions with source_chunk_ids     | > 70%  |
| Research Utilization   | % TraceLab reports referenced in CMOS | > 50%  |
| Orphan Research        | Collections with no CMOS references   | < 20%  |
| Evidence Depth         | Avg chunks per decision               | > 2    |

### Quality Metrics

| Metric       | Definition                              | Target    |
| ------------ | --------------------------------------- | --------- |
| Recency      | Avg age of research at decision time    | < 30 days |
| Relevance    | Avg similarity score of evidence chunks | > 0.7     |
| Completeness | Decisions with full traceability chain  | > 60%     |

---

## 8. Visualization

### Traceability Matrix

```
                    CMOS Decisions
                    D1   D2   D3   D4   D5
TraceLab      C1    ●    ○         ●
Chunks        C2    ●    ●              ●
              C3         ●    ●
              C4                   ●    ●
              C5    ○              ○

● = Primary evidence
○ = Supporting evidence
```

### Timeline View

```
Research Phase          Build Phase
────────────────────────────────────────────────────────
                                                    Time
Dec 15  │ TraceLab Mission: IOT-R1-DEEP
Dec 18  │ Collection created: 10 chunks
Dec 19  │ Report synthesized
Dec 20  │                     │ CMOS Sprint 16 planned
Dec 22  │                     │ Mission s16-m02 started
Dec 23  │                     │ Decision D1 (evidence: C1,C2)
Dec 26  │                     │ Deliverable completed
```

---

## 9. Best Practices

### For Researchers

1. **Name collections descriptively** - Include CMOS sprint/mission reference
2. **Add notes to chunks** - Explain why each chunk is relevant
3. **Synthesize before handing off** - Create report, don't just pass chunks
4. **Link missions** - Reference CMOS mission in TraceLab mission context

### For Builders

1. **Check reference_docs first** - Read TraceLab research before building
2. **Cite sources in decisions** - Always include source_chunk_ids
3. **Verify evidence** - Ensure cited chunks actually support decision
4. **Update on completion** - Note which research was most valuable

### For Reviewers

1. **Audit traceability** - Check decisions have evidence
2. **Question orphan research** - Why wasn't it used?
3. **Track utilization** - Monitor research → build conversion
4. **Identify gaps** - Find decisions needing more research

---

## 10. Future Enhancements

### Automated Linking

- **Semantic matching**: Auto-suggest TraceLab chunks when recording decision
- **Citation extraction**: Parse decision text for implicit references
- **Gap detection**: Alert when major decision lacks evidence

### Visualization Tools

- **Traceability graph**: Interactive D3 visualization of research → build links
- **Evidence browser**: Show decision with inline chunk previews
- **Timeline view**: Research and build activities on shared timeline

### Analytics Dashboard

- **Coverage heatmap**: Decisions vs. research areas
- **Utilization trends**: Research → build conversion over time
- **Quality scores**: Evidence strength by domain

---

## Appendix: Schema Changes Summary

```sql
-- strategic_decisions extensions
ALTER TABLE strategic_decisions
ADD COLUMN source_chunk_ids TEXT;  -- JSON array of TraceLab chunk UUIDs

ALTER TABLE strategic_decisions
ADD COLUMN tracelab_report_id TEXT;  -- UUID of synthesizing report

-- missions extensions
ALTER TABLE missions
ADD COLUMN tracelab_references TEXT;  -- JSON object with TraceLab links

-- metadata extensions
INSERT INTO metadata (key, value) VALUES
('tracelab_project_id', NULL),
('tracelab_sync_enabled', 'false'),
('traceability_version', '1.0');
```
