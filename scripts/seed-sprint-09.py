#!/usr/bin/env python3
"""Seed Sprint 09 and its missions into the CMOS SQLite database."""

import sqlite3
import sys
from pathlib import Path

DB_PATH = Path("cmos/db/cmos.sqlite")

def seed_sprint_09():
    """Insert Sprint 09 and all its missions."""
    
    sprint_data = {
        "id": "sprint-09",
        "title": "CMOS Integration & Self-Containment",
        "focus": "Make Mission Protocol work standalone with optional CMOS integration",
        "status": "planning",
        "start_date": "2025-11-08",
        "end_date": "2025-11-29",
        "total_missions": 8,
        "completed_missions": 0
    }
    
    missions = [
        {
            "id": "s09-m01",
            "name": "Phase 1: Update Default Paths to Project Root",
            "status": "queued",
            "notes": "Change DEFAULT_STATE_PATH from cmos/context/agentic_state.json to agentic_state.json. Change DEFAULT_SESSIONS_PATH from cmos/SESSIONS.jsonl to SESSIONS.jsonl. Update all path references in agentic-controller.ts. Move existing files from cmos/ to project root. Verify all tests pass."
        },
        {
            "id": "s09-m02",
            "name": "Phase 2: Test Standalone Operation Without cmos/",
            "status": "queued",
            "notes": "Hide cmos/ directory and verify all tests pass. Ensure Mission State Manager creates default files when they don't exist. Test mission execution workflow. Verify graceful handling of missing cmos/ directory. Document any remaining hard dependencies."
        },
        {
            "id": "s09-m03",
            "name": "Phase 3: Create CMOS Detector Utility",
            "status": "queued",
            "notes": "Create src/intelligence/cmos-detector.ts. Implement runtime detection of cmos/ directory presence. Add detection of SQLite database availability. Create singleton pattern for detector. Add caching to avoid repeated file system checks. Write unit tests for detection logic."
        },
        {
            "id": "s09-m04",
            "name": "Phase 4: Integrate CMOS Detection into Agentic Controller",
            "status": "queued",
            "notes": "Add CMOS detector to AgenticController constructor. Log detection status on initialization. Add configuration options for CMOS integration. Update constructor options to accept detector instance. Write integration tests with and without cmos/."
        },
        {
            "id": "s09-m05",
            "name": "Phase 5: Create SQLite Client for CMOS (Optional)",
            "status": "queued",
            "notes": "Create src/intelligence/sqlite-client.ts. Implement basic CRUD operations for missions table. Add session event logging methods. Create TypeScript types for SQLite schema. Add connection pooling and error handling. Make this an optional dependency."
        },
        {
            "id": "s09-m06",
            "name": "Phase 6: Create CMOS Sync Service (Optional)",
            "status": "queued",
            "notes": "Create src/intelligence/cmos-sync.ts. Implement bidirectional sync between files and SQLite. Add session event sync from Mission Protocol to CMOS. Create context sync methods. Add configuration for sync direction and frequency. Implement graceful degradation if sync fails."
        },
        {
            "id": "s09-m07",
            "name": "Phase 7: Integrate Optional Sync into Mission Lifecycle",
            "status": "queued",
            "notes": "Add sync calls to mission start/complete methods. Sync session events after each mission event. Add sync configuration to agents.md playbook. Make sync failures non-blocking. Add telemetry for sync operations. Test with sync enabled and disabled."
        },
        {
            "id": "s09-m08",
            "name": "Phase 8: Documentation and Final Validation",
            "status": "queued",
            "notes": "Update agents.md with CMOS integration configuration. Document standalone vs CMOS-integrated modes. Create migration guide for existing projects. Update README.md with architecture explanation. Final validation: remove cmos/ and verify everything works. Performance testing with and without CMOS."
        }
    ]
    
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Insert sprint
        cursor.execute("""
            INSERT INTO sprints (id, title, focus, status, start_date, end_date, total_missions, completed_missions)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            sprint_data["id"],
            sprint_data["title"],
            sprint_data["focus"],
            sprint_data["status"],
            sprint_data["start_date"],
            sprint_data["end_date"],
            sprint_data["total_missions"],
            sprint_data["completed_missions"]
        ))
        
        # Insert missions
        for mission in missions:
            cursor.execute("""
                INSERT INTO missions (id, sprint_id, name, status, notes)
                VALUES (?, ?, ?, ?, ?)
            """, (
                mission["id"],
                sprint_data["id"],
                mission["name"],
                mission["status"],
                mission["notes"]
            ))
        
        conn.commit()
        print(f"✅ Successfully seeded Sprint {sprint_data['id']}: {sprint_data['title']}")
        print(f"✅ Inserted {len(missions)} missions")
        
    except sqlite3.Error as e:
        print(f"❌ Database error: {e}")
        sys.exit(1)
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    seed_sprint_09()