def checksum(payload: bytes) -> int:
    return sum(payload) % 256
