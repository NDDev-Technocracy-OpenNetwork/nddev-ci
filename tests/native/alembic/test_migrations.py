from native import exercise


def test_empty_database():
    exercise()


def test_existing_revision_and_data():
    exercise(previous=True)
