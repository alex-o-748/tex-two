-- Durable generation: track retry attempts and when a row was claimed for processing.
ALTER TABLE submissions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN claimed_at INTEGER;
