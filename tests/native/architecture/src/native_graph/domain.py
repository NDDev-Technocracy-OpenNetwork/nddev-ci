def checksum(value: bytes) -> int:
    return sum(value) % 256
