ALTER TABLE tasks ADD COLUMN rework_round INTEGER CHECK (rework_round IS NULL OR rework_round > 0);
ALTER TABLE comments ADD COLUMN rework_round INTEGER CHECK (rework_round IS NULL OR rework_round > 0);
