"""Copy optional administrator-prepared upstream bytes; missing is not a cache hit."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import sys
import tempfile
from pathlib import Path


def copy_prepared(root: Path, expected: str, destination: Path, *, owner_uid: int = 0) -> bool:
    if os.name != "posix":
        raise ValueError("Prepared local artifact storage requires a supported POSIX host")
    import fcntl

    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Prepared artifact lookup requires the requested exact SHA-256")
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError("Prepared storage must have an absolute nonsymlinked path")
    if not root.exists():
        return False
    for parent in (root, root / "sha256"):
        if not parent.exists():
            return False
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
            raise ValueError("Prepared storage must be administrator-owned and not job-writable")
    source = root / "sha256" / expected
    try:
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return False
    temporary = None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o222:
            raise ValueError("Prepared artifact must be an immutable administrator-owned file")
        fcntl.flock(fd, fcntl.LOCK_SH)
        output, name = tempfile.mkstemp(prefix=".prepared-", dir=destination.parent)
        temporary = Path(name)
        value = hashlib.sha256()
        with os.fdopen(output, "wb") as target:
            while True:
                part = os.read(fd, 1024 * 1024)
                if not part:
                    break
                value.update(part)
                target.write(part)
        if value.hexdigest() != expected:
            raise ValueError("Prepared artifact bytes do not match the requested upstream SHA-256")
        os.replace(temporary, destination)
        return True
    finally:
        os.close(fd)
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    if len(sys.argv) != 4:
        print("Expected prepared root, SHA-256 and job-local destination", file=sys.stderr)
        return 2
    try:
        found = copy_prepared(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
        if found:
            print("Reused verified prepared upstream bytes", file=sys.stderr)
        return 0 if found else 1
    except (OSError, ValueError) as error:
        print(f"Prepared artifact rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
