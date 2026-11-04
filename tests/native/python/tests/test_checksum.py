from ciwf_fixture import checksum


def test_checksum_is_stable() -> None:
    assert checksum("ci") == 204
    assert checksum("") == 0


def test_checksum_stays_in_one_byte() -> None:
    for sample in ("", "a", "the quick brown fox", "ü" * 40):
        assert 0 <= checksum(sample) <= 255
