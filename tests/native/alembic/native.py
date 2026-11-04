"""Real empty-database and previous-revision migrations with preserved existing data."""

import sqlite3
import sys
import tempfile
from pathlib import Path

from alembic import command
from alembic.config import Config


def exercise(previous=False):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "service.sqlite"
        settings = Config("alembic.ini")
        settings.set_main_option("sqlalchemy.url", "sqlite:///" + str(path))
        if previous:
            command.upgrade(settings, "001")
            with sqlite3.connect(path) as connection:
                connection.execute("INSERT INTO items(id) VALUES (1)")
        command.upgrade(settings, "head")
        with sqlite3.connect(path) as connection:
            assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == ("002",)
            columns = [row[1] for row in connection.execute("PRAGMA table_info(items)")]
            assert columns == ["id", "name"]
            if previous:
                assert connection.execute("SELECT id,name FROM items").fetchone() == (1, None)


if __name__ == "__main__":
    exercise(sys.argv[1] == "previous")
