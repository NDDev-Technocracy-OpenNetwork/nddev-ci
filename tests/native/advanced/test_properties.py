from checksum import checksum
from hypothesis import given, settings
from hypothesis import strategies as st


@settings(deadline=1000, print_blob=True)
@given(st.binary(), st.binary())
def test_checksum_composes_modulo_one_byte(left, right):
    assert checksum(left + right) == (checksum(left) + checksum(right)) % 256
    assert 0 <= checksum(left) <= 255


def test_known_boundary_values():
    assert checksum(b"ci") == 204
    assert checksum(bytes([255, 1])) == 0
