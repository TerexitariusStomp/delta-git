-- Visitor-compute (Chimera): site-level earn card toggle
ALTER TABLE sites ADD COLUMN earn_enabled INTEGER NOT NULL DEFAULT 0;
