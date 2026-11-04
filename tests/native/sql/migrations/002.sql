ALTER TABLE readings ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
PRAGMA user_version = 2;
