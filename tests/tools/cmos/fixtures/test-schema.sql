-- Test Schema for CMOS MCP Tools
-- This SQL is used by test fixtures to create a consistent test database

-- Sprints table
CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  title TEXT,
  focus TEXT,
  status TEXT,
  start_date TEXT,
  end_date TEXT,
  total_missions INTEGER,
  completed_missions INTEGER
);

-- Missions table (matches production schema)
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT,
  notes TEXT,
  objective TEXT,
  context TEXT,
  success_criteria TEXT,
  deliverables TEXT,
  reference_docs TEXT,
  domain_fields TEXT,
  metadata TEXT
);

-- Contexts table
CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  sprint_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  agent TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  captures TEXT,
  next_steps TEXT,
  metadata TEXT
);
