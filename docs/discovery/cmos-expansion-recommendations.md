# CMOS Project Type Expansion Recommendations

**Mission**: s15-m02
**Date**: 2025-12-27
**Status**: Complete

## Overview

CMOS currently optimizes for **software engineering** projects. This document analyzes expansion to:

1. **Design projects** - UX/UI, product design, brand work
2. **Research projects** - User research, market analysis, discovery

---

## 1. Design Project Support

### Current Gap Analysis

CMOS missions assume code deliverables. Design work has different:

- **Deliverable types**: Wireframes, mockups, prototypes, specs
- **Review cycles**: Design critiques, stakeholder reviews
- **Tools**: Figma, Sketch, design systems
- **Success criteria**: Visual consistency, usability, brand alignment

### Proposed: Design Domain Pack

#### Domain-Specific Fields

```yaml
domain_fields:
  design_system_version: '2.4.0'
  figma_file_url: 'https://figma.com/file/...'
  prototype_url: 'https://figma.com/proto/...'
  review_status: 'pending_critique' # draft, pending_critique, approved, needs_revision
  design_tokens: ['color-primary', 'spacing-md']
  accessibility_level: 'WCAG AA'
```

#### Design Mission Template

```yaml
mission:
  id: 's01-m02'
  name: 'Dashboard Redesign'
  type: 'design'
  objective: 'Redesign analytics dashboard for improved data visualization'

  # Design-specific sections
  design_context:
    current_state: 'Legacy dashboard with dated UI patterns'
    user_feedback: 'Confusion about metric meanings, slow load perception'
    constraints:
      - 'Must use existing design system tokens'
      - 'Mobile responsiveness required'
      - 'Accessibility: WCAG AA minimum'

  deliverables:
    - type: 'wireframe'
      description: 'Low-fidelity dashboard layout options (3 variants)'
      format: 'Figma'
    - type: 'mockup'
      description: 'High-fidelity selected design'
      format: 'Figma'
    - type: 'prototype'
      description: 'Interactive prototype for usability testing'
      format: 'Figma prototype'
    - type: 'spec'
      description: 'Developer handoff documentation'
      format: 'Figma dev mode + Markdown'

  success_criteria:
    - '3 wireframe variants presented to stakeholders'
    - 'Design critique completed with feedback incorporated'
    - 'Prototype passes internal usability review'
    - 'All components use design system tokens'
    - 'Accessibility audit: no critical violations'

  review_gates:
    - name: 'Wireframe Review'
      reviewers: ['product', 'engineering']
      required_before: 'mockup'
    - name: 'Design Critique'
      reviewers: ['design_lead']
      required_before: 'prototype'
    - name: 'Stakeholder Approval'
      reviewers: ['product_owner']
      required_before: 'handoff'
```

#### Design-Specific Session Types

```typescript
// Add to session types
type DesignSessionType =
  | 'design_critique' // Structured design review
  | 'user_testing' // Usability testing session
  | 'stakeholder_review' // Approval meeting
  | 'design_sprint'; // Intensive design workshop
```

#### Design Capture Categories

```typescript
// Add to capture categories
type DesignCaptureCategory =
  | 'design_decision' // Visual/UX choice made
  | 'feedback' // Stakeholder/user feedback
  | 'pattern' // Reusable pattern identified
  | 'accessibility_issue'; // A11y finding
```

### Design Workflow Integration

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Discovery  │───▶│  Wireframe  │───▶│   Mockup    │
│   Mission   │    │   Mission   │    │   Mission   │
└─────────────┘    └─────────────┘    └─────────────┘
                          │                  │
                   ┌──────▼──────┐    ┌──────▼──────┐
                   │   Design    │    │ Stakeholder │
                   │  Critique   │    │   Review    │
                   │  (Session)  │    │  (Session)  │
                   └─────────────┘    └─────────────┘
                                            │
                                     ┌──────▼──────┐
                                     │  Prototype  │
                                     │   Mission   │
                                     └─────────────┘
                                            │
                                     ┌──────▼──────┐
                                     │   Handoff   │
                                     │   Mission   │
                                     └─────────────┘
```

---

## 2. Research Project Support

### Current Gap Analysis

Research projects differ from build projects:

- **Deliverables**: Reports, insights, recommendations
- **Process**: Data collection, synthesis, triangulation
- **Tools**: Interview guides, surveys, analysis frameworks
- **Success**: Quality of insights, not working code

### Proposed: Research Domain Pack

#### Domain-Specific Fields

```yaml
domain_fields:
  research_type: 'generative' # generative, evaluative, foundational
  methodology: 'qualitative' # qualitative, quantitative, mixed
  sample_size: 12
  participants_interviewed: 8
  tracelab_project_id: 'proj-abc123'
  confidence_level: 'medium'
  synthesis_status: 'in_progress'
```

#### Research Mission Template

```yaml
mission:
  id: 'r01-m02'
  name: 'User Onboarding Pain Points'
  type: 'research'
  objective: 'Identify friction points in user onboarding flow'

  research_context:
    research_questions:
      - 'Where do users get stuck during onboarding?'
      - 'What expectations do users have vs. reality?'
      - 'Which steps cause the most abandonment?'
    hypotheses:
      - 'Email verification step causes significant drop-off'
      - 'Users expect immediate value demonstration'
    prior_research:
      - 'Q3 NPS survey indicated onboarding frustration'
      - 'Analytics show 40% drop at step 3'

  methodology:
    approach: 'Semi-structured interviews + session recordings'
    sample:
      target: 12
      criteria: 'Users who signed up in last 30 days'
      segments: ['completed_onboarding', 'abandoned_onboarding']
    data_collection:
      - '45-minute remote interviews'
      - 'Session recording review (Fullstory)'
      - 'Onboarding survey responses'

  deliverables:
    - type: 'interview_guide'
      description: 'Semi-structured interview protocol'
    - type: 'raw_data'
      description: 'Interview transcripts (TraceLab)'
    - type: 'affinity_map'
      description: 'Synthesized themes and patterns'
    - type: 'insights_report'
      description: 'Key findings with evidence'
    - type: 'recommendations'
      description: 'Prioritized improvement suggestions'

  success_criteria:
    - 'Minimum 10 interviews completed'
    - '3+ distinct pain point themes identified'
    - 'Each insight supported by 3+ data points'
    - 'Recommendations prioritized by impact/effort'
    - 'Findings reviewed with product team'

  traceability:
    tracelab_collection: 'onboarding-research-q4'
    source_documents: [] # Populated as interviews complete
    synthesis_chunks: [] # TraceLab chunk IDs
```

#### Research-Specific Session Types

```typescript
// Add to session types
type ResearchSessionType =
  | 'interview' // User interview session
  | 'synthesis' // Data analysis/theming session
  | 'workshop' // Collaborative research workshop
  | 'findings_review'; // Present findings to stakeholders
```

#### Research Capture Categories

```typescript
// Add to capture categories
type ResearchCaptureCategory =
  | 'observation' // Raw user behavior/quote
  | 'insight' // Pattern or finding
  | 'hypothesis' // Emerging theory
  | 'recommendation' // Actionable suggestion
  | 'quote'; // Verbatim user quote
```

### TraceLab Integration

For research projects, TraceLab becomes the primary data store:

```
┌─────────────────────────────────────────────────────────┐
│                      TraceLab                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │Documents │  │ Chunks   │  │     Collections      │  │
│  │(Sources) │  │(Indexed) │  │  (Research Themes)   │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────┘
              │                        ▲
              │  search_knowledge()    │  create_report()
              ▼                        │
┌─────────────────────────────────────────────────────────┐
│                        CMOS                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ Missions │  │ Sessions │  │ Strategic Decisions  │  │
│  │(Workflow)│  │(Captures)│  │   (Research→Build)   │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

#### Cross-Reference Fields

```yaml
# In CMOS mission
tracelab_links:
  project_id: 'proj-abc123'
  collection_ids: ['col-def456', 'col-ghi789']
  report_ids: ['rpt-jkl012']

# In TraceLab project
cmos_links:
  sprint_id: 'sprint-15'
  mission_ids: ['r01-m01', 'r01-m02']
```

### Research Workflow Integration

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Planning  │───▶│    Data     │───▶│  Synthesis  │
│   Mission   │    │ Collection  │    │   Mission   │
│             │    │   Mission   │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
      │                  │                   │
      │           ┌──────▼──────┐     ┌──────▼──────┐
      │           │  Interview  │     │  Synthesis  │
      │           │  Sessions   │     │   Session   │
      │           │ (→TraceLab) │     │ (Theming)   │
      │           └─────────────┘     └─────────────┘
      │                                      │
      │                               ┌──────▼──────┐
      │                               │   Report    │
      │                               │ Generation  │
      │                               │   Mission   │
      │                               └─────────────┘
      │                                      │
      │                               ┌──────▼──────┐
      └───────────────────────────────│  Findings   │
              (inform next research)  │   Review    │
                                      │  (Session)  │
                                      └─────────────┘
```

---

## 3. Implementation Strategy

### Phase 1: Schema Extensions

Add domain_fields support (already exists, document patterns):

```sql
-- domain_fields is JSON, can hold any structure
-- Document expected shapes per project type
```

### Phase 2: Template Library

Create template missions for each project type:

```
cmos/templates/
├── software/
│   ├── feature.yaml
│   ├── bugfix.yaml
│   └── refactor.yaml
├── design/
│   ├── wireframe.yaml
│   ├── mockup.yaml
│   └── prototype.yaml
└── research/
    ├── interview-study.yaml
    ├── survey.yaml
    └── competitive-analysis.yaml
```

### Phase 3: Domain Pack Tools

Add MCP tools for domain-specific operations:

```typescript
// Design tools
cmos_design_review_create(); // Create review gate
cmos_design_status(); // Aggregate design progress

// Research tools
cmos_research_link_tracelab(); // Connect TraceLab project
cmos_research_participant_log(); // Track interview completion
cmos_research_synthesis_start(); // Begin synthesis session
```

### Phase 4: Project Type Detection

Infer project type from mission patterns:

```typescript
function detectProjectType(missions: Mission[]): ProjectType {
  const hasDesignDeliverables = missions.some((m) =>
    m.deliverables?.some((d) => ['wireframe', 'mockup', 'prototype'].includes(d.type))
  );

  const hasResearchDeliverables = missions.some((m) =>
    m.deliverables?.some((d) =>
      ['interview_guide', 'insights_report', 'affinity_map'].includes(d.type)
    )
  );

  if (hasDesignDeliverables) return 'design';
  if (hasResearchDeliverables) return 'research';
  return 'software';
}
```

---

## 4. Cross-Project Workflow

Real projects often span types. Example: Product improvement

```
┌────────────────────────────────────────────────────────────┐
│                    Sprint: "Dashboard v2"                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Research Phase (research missions)                        │
│  ├── r-m01: User interview study                           │
│  ├── r-m02: Analytics review                               │
│  └── r-m03: Competitive analysis                           │
│                                                            │
│  Design Phase (design missions)                            │
│  ├── d-m01: Wireframe exploration                          │
│  ├── d-m02: High-fidelity mockups                          │
│  └── d-m03: Interactive prototype                          │
│                                                            │
│  Build Phase (software missions)                           │
│  ├── s-m01: Component implementation                       │
│  ├── s-m02: API integration                                │
│  └── s-m03: Testing & QA                                   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

CMOS handles this via:

1. **Sprint-level organization**: All phases in one sprint
2. **Mission dependencies**: `d-m01 Requires r-m03`
3. **Cross-type sessions**: Research findings → Design decisions → Build constraints

---

## 5. Recommendations Summary

### Immediate (Sprint 16)

1. **Document domain_fields patterns** for design and research
2. **Create template missions** for common project types
3. **Add project_type field** to sprints table

### Near-term (Sprint 17-18)

4. **Add design session types** (critique, stakeholder review)
5. **Add research capture categories** (observation, insight, quote)
6. **TraceLab linking fields** in missions schema

### Long-term (Sprint 19+)

7. **Domain pack MCP tools** for type-specific operations
8. **Project type detection** and suggestions
9. **Cross-type workflow templates**

---

## 6. Success Criteria for Expansion

### Design Project Support

- [ ] Designer can create mission with design-specific deliverables
- [ ] Design critique sessions capture visual decisions
- [ ] Review gates block progression until approval
- [ ] Figma/prototype links tracked per mission

### Research Project Support

- [ ] Researcher can create study mission with methodology
- [ ] Interview sessions integrate with TraceLab
- [ ] Synthesis sessions produce TraceLab collections
- [ ] Findings flow into strategic decisions

### Cross-Project Integration

- [ ] Sprint can contain mixed project types
- [ ] Dependencies work across types
- [ ] Context aggregates insights from all types
- [ ] Agent onboard understands project type

---

## Appendix: Field Glossary

### Design Fields

| Field                 | Type   | Description                                       |
| --------------------- | ------ | ------------------------------------------------- |
| design_system_version | string | Design system version in use                      |
| figma_file_url        | string | Link to Figma file                                |
| prototype_url         | string | Link to interactive prototype                     |
| review_status         | enum   | draft, pending_critique, approved, needs_revision |
| accessibility_level   | string | Target WCAG level                                 |

### Research Fields

| Field                    | Type   | Description                          |
| ------------------------ | ------ | ------------------------------------ |
| research_type            | enum   | generative, evaluative, foundational |
| methodology              | enum   | qualitative, quantitative, mixed     |
| sample_size              | number | Target participant count             |
| participants_interviewed | number | Actual interviews completed          |
| tracelab_project_id      | string | Linked TraceLab project              |
| confidence_level         | enum   | low, medium, high                    |
| synthesis_status         | enum   | not_started, in_progress, complete   |
