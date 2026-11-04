"""Run intentional trusted native commands with bounded failure-preserving execution."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from contextlib import nullcontext
from pathlib import Path

from .diagnostic_export import register
from .model import Invalid, git_environment


def terminate(child: subprocess.Popen, stream, *, grace_seconds: int = 5) -> None:
    """Reap this operation's leader and kill its remaining group, even after the leader exits."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(child.pid), "/T", "/F"],
            check=False,
            stdout=stream,
            stderr=subprocess.STDOUT,
        )
        if child.poll() is None:
            child.kill()
        child.wait()
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # wait() observes only the leader. Its descendants may ignore TERM and keep the group alive.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()


def cancelled(_signal, _frame) -> None:
    raise KeyboardInterrupt


def run(
    command: list[str] | str,
    root: Path,
    log: Path,
    *,
    timeout: int = 900,
    env: dict[str, str] | None = None,
    stderr_log: Path | None = None,
) -> dict:
    if not command or not isinstance(timeout, int) or timeout < 1 or timeout > 7200:
        raise Invalid("Native command and bounded timeout (1..7200 seconds) are required")
    if isinstance(command, str):
        # Only explicitly trusted project commands use a shell. All other inputs are data.
        command = (
            [
                "pwsh",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Native command strings require PowerShell 7.3 or newer' }; "
                "$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true; "
                + command
                + "; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
            ]
            if os.name == "nt"
            else ["bash", "--noprofile", "--norc", "-euo", "pipefail", "-c", command]
        )
    if not all(isinstance(word, str) and "\0" not in word for word in command):
        raise Invalid("Command must contain valid argument strings")
    log.parent.mkdir(parents=True, exist_ok=True)
    register(log)
    if stderr_log is not None:
        register(stderr_log)
    started = time.monotonic()
    status, code, detail = "failure", None, ""
    with (
        log.open("w", encoding="utf-8") as stream,
        stderr_log.open("w", encoding="utf-8") if stderr_log else nullcontext(None) as errors,
    ):
        try:
            child_environment = {
                k: v
                for k, v in os.environ.items()
                if k not in {"UV_PROJECT_ENVIRONMENT", "UV_PROJECT", "VIRTUAL_ENV", "PYTHONPATH"}
            }
            child = subprocess.Popen(
                command,
                cwd=root,
                env=git_environment({**child_environment, **(env or {})}),
                stdout=stream,
                stderr=errors if errors is not None else subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=os.name != "nt",
            )
            previous_handler = None
            if threading.current_thread() is threading.main_thread():
                previous_handler = signal.signal(signal.SIGTERM, cancelled)
            try:
                code = child.wait(timeout=timeout)
                status = "success" if code == 0 else "failure"
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                detail = "cancelled" if isinstance(error, KeyboardInterrupt) else "timeout"
                # Cancellation can come from an outer library deadline. Reap our SDK group
                # before that caller's own grace window kills this intermediate process.
                terminate(child, stream, grace_seconds=1 if isinstance(error, KeyboardInterrupt) else 5)
                code = child.returncode
            finally:
                if previous_handler is not None:
                    signal.signal(signal.SIGTERM, previous_handler)
        except FileNotFoundError as error:
            status, detail = "unavailable", f"Required executable is absent: {error.filename}"
            stream.write(detail + "\n")
    return {
        "status": status,
        "exit_code": code,
        "seconds": round(time.monotonic() - started, 4),
        "detail": detail,
        "log": str(log),
    }
