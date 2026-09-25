ALTER TABLE attachments
  ADD COLUMN body_fallback INTEGER NOT NULL DEFAULT 1 CHECK (body_fallback IN (0, 1));
