# [Your Project Name]

**Status**: [In Development / Beta / Production]  
**Managed with**: CMOS (Context + Mission Orchestration System)

[Brief 2-3 sentence description of what your project does and why it exists]

---

## Quick Start

```bash
# Install dependencies
[your install command]

# Setup environment
[your setup commands]

# Run development server
[your dev command]

# Run tests
[your test command]
```

---

## Project Documentation

- **Roadmap**: See `docs/roadmap.md` for project vision and sprint plan
- **Technical Architecture**: See `docs/technical_architecture.md` for system design
- **API Documentation**: [Link to your API docs if applicable]

---

## Development

### Prerequisites
- [Language] [version]
- [Database] [version]
- [Other dependencies]

### Environment Setup
```bash
# [Step-by-step setup instructions]
```

### Running Tests
```bash
# [Your test commands]
```

### Building for Production
```bash
# [Your build commands]
```

---

## Project Management with CMOS

This project uses CMOS for project memory and the workflow selected by its active tier.

**For contributors**:
- Mission tracking, project history and session logs all live in `cmos/db/cmos.sqlite`

**For AI agents**:
- Application code guidance: See `agents.md` (this project root)
- CMOS operations guidance: See the active `cmos/tiers/{tier}.md`
- Build session prompts: See `cmos/docs/build-session-prompt.md`

**CMOS operations** (via the CMOS MCP tools, from an agent session):
```
# View current mission status
cmos_mission(action="status")

# View sprint progress
cmos_sprint(action="show", sprintId="<id>")

# Validate system integrity
cmos_db(action="health")
```

---

## Contributing

[Your contribution guidelines]

---

## License

[Your license]

---

## CMOS Directory

The `cmos/` directory contains project management infrastructure:
- Mission and sprint tracking
- Context and session history
- Tier guides, templates, foundational documents, and CMOS documentation

**Do not write application code in `cmos/`** - it's for project management only.

See `cmos/README.md` for CMOS-specific documentation.
