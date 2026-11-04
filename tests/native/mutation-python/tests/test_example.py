from example import add_one


def test_actual_addition():
    assert add_one(2) == 3
    assert add_one(-1) == 0
