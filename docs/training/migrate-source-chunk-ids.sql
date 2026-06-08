-- Migration: Add source_chunk_ids to strategic_decisions
-- Sprint: sprint-18
-- Mission: s18-m01
-- Purpose: Enable decision provenance by linking strategic decisions to TraceLab research chunks
--
-- Run this migration on existing CMOS databases to add TraceLab provenance support.
-- The column stores a JSON array of TraceLab chunk UUIDs that informed the decision.

-- Add the source_chunk_ids column (nullable, stores JSON array)
ALTER TABLE strategic_decisions ADD COLUMN source_chunk_ids TEXT;

-- Example usage after migration:
-- INSERT INTO strategic_decisions (decision_text, created_at, source_chunk_ids)
-- VALUES ('Use SQLite for local storage', datetime('now'), '["chunk-uuid-1", "chunk-uuid-2"]');

-- Verify migration:
-- SELECT * FROM strategic_decisions WHERE source_chunk_ids IS NOT NULL;
