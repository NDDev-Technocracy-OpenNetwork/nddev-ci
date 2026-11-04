from .domain import checksum


def identity(value: str) -> int:
    return checksum(value.encode())
