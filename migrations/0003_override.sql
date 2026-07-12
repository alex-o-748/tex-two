-- Curator override: when set, the pipeline skips both moderation steps for this submission.
ALTER TABLE submissions ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
