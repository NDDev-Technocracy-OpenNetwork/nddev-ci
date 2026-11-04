CREATE TABLE readings (
    id INTEGER PRIMARY KEY,
    value INTEGER NOT NULL CHECK (value >= 0)
);
PRAGMA user_version = 1;
