import os
import time

import pytest


@pytest.mark.benchmark(min_rounds=5, max_time=0.05)
def test_native_benchmark_case(benchmark):
    def operation():
        if os.environ.get("NDDEV_BENCHMARK_SLOW") == "true":
            time.sleep(0.005)
        return sum(range(100))

    assert benchmark(operation) == 4950
