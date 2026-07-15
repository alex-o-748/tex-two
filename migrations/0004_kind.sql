-- Visitor-edited uploads: distinguish a hand-edited image submission from the
-- default AI-prompt path. 'prompt' = transform the original via AI; 'upload' =
-- the visitor uploaded their own edited image, which is moderated and shown as-is.
ALTER TABLE submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt';
