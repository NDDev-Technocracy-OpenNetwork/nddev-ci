"""Smallest installable package that still proves python-ci really runs."""


def checksum(text: str) -> int:
    """Sum the bytes of *text* modulo 256."""
    return sum(text.encode("utf-8")) % 256


def main() -> None:
    assert checksum("ci") == 204
    print("Built-wheel CLI checksum verified")
