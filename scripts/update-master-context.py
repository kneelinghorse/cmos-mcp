#!/usr/bin/env python3
"""Update MASTER_CONTEXT.json with session findings and create a snapshot."""

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path("cmos/db/cmos.sqlite")
MASTER_CONTEXT_PATH = Path("cmos/context/MASTER_CONTEXT.json")

def create_master_context_update():
    """Create updated MASTER_CONTEXT with session findings."""
    
    context_data = {
        "project": {
            "name": "CMOS Starter Template",
            "version": "0.0.0",
            "description": "Updated with Mission Protocol CMOS integration analysis - Nov 2025",
            "status": "active_development",
            "start_date": "2025-11-07",
            "deployment": {
                "platform": "Local/Node.js",
                "integration_target": "Mission Protocol v2 with optional CMOS support",
                "environment": "development"
            }
        },
        "working_memory": {
            "active_domain": "cmos_integration",
            "session_count": 1,
            "last_session": "2025-11-07T22:30:00Z",
            "agents_md_path": "./agents.md",
            "agents_md_loaded": True,
            "active_mission": "cmos_integration_planning",
            "domains": {
                "cmos_integration": {
                    "status": "analysis_complete",
                    "priority": 1,
                    "current_mission": "sprint-09-planning",
                    "missions": {
                        "sprint-09": {
                            "id": "sprint-09",
                            "title": "CMOS Integration & Self-Containment",
                            "status": "planned",
                            "total_missions": 8,
                            "focus": "Make Mission Protocol work standalone with optional CMOS integration"
                        }
                    },
                    "critical_facts": [
                        "Mission Protocol must work standalone without cmos/ directory",
                        "CMOS is internal project management and will be removed before publishing",
                        "Integration must be optional and non-breaking",
                        "Default paths must move from cmos/ subdirectory to project root",
                        "CMOS detection must be runtime-based with graceful degradation"
                    ],
                    "constraints": [
                        "Cannot assume cmos/ directory exists",
                        "All hardcoded cmos/ paths must be removed",
                        "Sync operations must be non-blocking",
                        "Must maintain backward compatibility",
                        "Performance impact must be < 2%"
                    ],
                    "decisions_made": [
                        "Mission Protocol will use file-based storage by default (project root)",
                        "CMOS SQLite integration will be optional enhancement",
                        "Created 8-mission sprint to implement changes incrementally",
                        "Phased approach: self-containment → detection → optional sync",
                        "Dual-write strategy for migration period"
                    ],
                    "files_created": [
                        "analysis/cmos-integration-gap-analysis.md",
                        "analysis/integration-architecture-plan.md",
                        "analysis/migration-path.md",
                        "scripts/seed-sprint-09.py"
                    ],
                    "key_insights": [
                        "Original analysis incorrectly assumed tight coupling",
                        "Revised approach focuses on loose, optional integration",
                        "CMOS detection must not impact performance when absent",
                        "Sync service must be completely optional"
                    ]
                }
            }
        },
        "technical_context": {
            "dependencies": [
                "Node.js 18+",
                "TypeScript 5+",
                "Python 3.11+ (for CMOS only)",
                "SQLite 3+ (optional)"
            ],
            "tooling": {
                "seed_database": "python scripts/seed_sqlite.py --data-root <path>",
                "validate_parity": "python scripts/validate_parity.py",
                "update_context": "python scripts/update-master-context.py"
            },
            "reference_docs": [
                "analysis/cmos-integration-gap-analysis.md",
                "analysis/integration-architecture-plan.md",
                "analysis/migration-path.md"
            ],
            "integration_points": [
                "Optional CMOS detection in Mission Protocol",
                "Optional sync service for data sharing",
                "File-based storage with SQLite as secondary"
            ]
        },
        "sprint_tracking": {
            "current_sprint": "sprint-09",
            "sprint_start": "2025-11-08",
            "sprint_end": "2025-11-29",
            "sprint_status": "planning"
        },
        "context_health": {
            "anti_pattern_detection": True,
            "compression_enabled": False,
            "last_reset": "2025-11-07T22:30:00Z",
            "sessions_since_reset": 1,
            "size_kb": 0,
            "size_limit_kb": 100
        },
        "ai_instructions": {
            "preferred_language": "yaml",
            "code_style": "mission_protocol_v2",
            "testing_required": True,
            "documentation_level": "comprehensive",
            "special_instructions": [
                "Always check for cmos/ directory existence before assuming it's present",
                "Use configurable paths instead of hardcoded cmos/ paths",
                "Implement graceful degradation for all CMOS-dependent features",
                "Maintain backward compatibility at all times",
                "Document optional vs required features clearly"
            ]
        },
        "next_session_context": {
            "blockers": [],
            "important_reminders": [
                "Start with Phase 1 missions (s09-m01, s09-m02) to establish self-containment",
                "Verify all tests pass without cmos/ before proceeding to detection phase",
                "Keep sync service completely optional and non-blocking",
                "Update documentation after each phase"
            ],
            "key_reference_documents": [
                "analysis/cmos-integration-gap-analysis.md",
                "analysis/integration-architecture-plan.md",
                "analysis/migration-path.md"
            ],
            "when_we_resume": [
                "Begin implementation of s09-m01: Update default paths",
                "Test standalone operation after each change",
                "Create CMOS detector utility (s09-m03)",
                "Integrate detection into AgenticController (s09-m04)"
            ]
        },
        "metadata": {
            "migrated_at": "2025-11-06T05:09:02.870476+00:00",
            "source_version": "cmos-v1",
            "last_updated": "2025-11-07T22:30:00Z",
            "session_summary": "Completed comprehensive analysis of Mission Protocol and CMOS integration. Created 3 analysis documents, 8-mission sprint plan, and seeded database. Established correct architecture: Mission Protocol standalone with optional CMOS integration."
        }
    }
    
    # Write to MASTER_CONTEXT.json
    MASTER_CONTEXT_PATH.write_text(
        json.dumps(context_data, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )
    
    print(f"✅ Updated MASTER_CONTEXT.json at {MASTER_CONTEXT_PATH}")
    return context_data

def create_context_snapshot(context_data):
    """Create a snapshot in the SQLite database."""
    
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Check if master_context exists
        cursor.execute("SELECT id FROM contexts WHERE id = 'master_context'")
        exists = cursor.fetchone()
        
        if exists:
            # Update existing
            cursor.execute("""
                UPDATE contexts 
                SET content = ?, updated_at = ?
                WHERE id = 'master_context'
            """, (
                json.dumps(context_data, indent=2, ensure_ascii=False),
                datetime.now(timezone.utc).isoformat()
            ))
            print("✅ Updated existing master_context record")
        else:
            # Insert new
            cursor.execute("""
                INSERT INTO contexts (id, source_path, content, updated_at)
                VALUES (?, ?, ?, ?)
            """, (
                "master_context",
                str(MASTER_CONTEXT_PATH),
                json.dumps(context_data, indent=2, ensure_ascii=False),
                datetime.now(timezone.utc).isoformat()
            ))
            print("✅ Created new master_context record")
        
        # Create snapshot
        cursor.execute("""
            INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            "master_context",
            "session-2025-11-07-cmos-analysis",
            str(MASTER_CONTEXT_PATH),
            "snapshot_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S"),
            json.dumps(context_data, indent=2, ensure_ascii=False),
            datetime.now(timezone.utc).isoformat()
        ))
        
        conn.commit()
        print("✅ Created context snapshot in SQLite")
        
    except sqlite3.Error as e:
        print(f"❌ Database error: {e}")
        sys.exit(1)
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    print("Updating MASTER_CONTEXT.json with session findings...")
    context_data = create_master_context_update()
    
    print("\nCreating context snapshot in SQLite...")
    create_context_snapshot(context_data)
    
    print("\n✅ Master context update complete!")
    print(f"   - MASTER_CONTEXT.json updated")
    print(f"   - SQLite context record updated")
    print(f"   - Context snapshot created")
    print(f"\nKey session outcomes captured:")
    print(f"   - Mission Protocol must work standalone")
    print(f"   - CMOS integration is optional")
    print(f"   - Sprint 09 created with 8 missions")
    print(f"   - Analysis documents created in analysis/ directory")