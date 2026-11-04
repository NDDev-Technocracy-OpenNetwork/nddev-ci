"""Cancellation must reap a nested native SDK before the outer grace window expires."""

import os
import signal
import sys
import time

import pytest

from nddev_cicd.process import run


@pytest.mark.skipif(os.name == "nt", reason="POSIX nested process-group cancellation")
def test_outer_budget_cancels_a_nested_sdk_without_leaving_its_process(tmp_path):
    marker = tmp_path / "sdk.pid"
    sdk = f"import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path({str(marker)!r}).write_text(str(os.getpid()));time.sleep(30)"
    nested = f"from pathlib import Path;import sys;from nddev_cicd.process import run;run([sys.executable,'-c',{sdk!r}],Path({str(tmp_path)!r}),Path({str(tmp_path / 'sdk.log')!r}),timeout=30)"
    started = time.monotonic()
    result = run([sys.executable, "-c", nested], tmp_path, tmp_path / "outer.log", timeout=3)
    elapsed = time.monotonic() - started
    pid = int(marker.read_text())
    alive = False
    try:
        os.kill(pid, 0)
        alive = True
    except ProcessLookupError:
        pass
    finally:
        if alive:
            os.kill(pid, signal.SIGKILL)  # only the SDK process created and recorded by this fixture
    assert result["status"] == "failure" and result["detail"] == "timeout"
    assert not alive, f"Nested SDK {pid} remained after outer cancellation ({elapsed:.3f}s)"
