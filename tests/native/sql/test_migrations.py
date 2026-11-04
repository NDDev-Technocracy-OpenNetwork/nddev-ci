"""Exercise actual SQLite schema transitions and constraints in disposable databases."""

import sqlite3
from pathlib import Path

import pytest


def apply(connection, number):
    connection.executescript(Path(f"migrations/{number:03}.sql").read_text())


def test_empty_database_to_current_schema():
    with sqlite3.connect(":memory:") as connection:
        apply(connection, 1)
        apply(connection, 2)
        connection.execute("INSERT INTO readings(id, value, source) VALUES (?, ?, ?)", (1, 42, "sensor"))
        assert connection.execute("SELECT value, source FROM readings").fetchall() == [(42, "sensor")]
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("INSERT INTO readings(id, value) VALUES (?, ?)", (2, -1))
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("INSERT INTO readings(id, value) VALUES (?, ?)", (1, 100))


def test_previous_schema_preserves_existing_data():
    with sqlite3.connect(":memory:") as connection:
        apply(connection, 1)
        connection.execute("INSERT INTO readings(id, value) VALUES (?, ?)", (7, 19))
        apply(connection, 2)
        assert connection.execute("SELECT id, value, source FROM readings").fetchall() == [(7, 19, "legacy")]
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
