const lanes = ["release", "foreground", "maintenance"];

function expectedDuration(samples) {
  if (!Array.isArray(samples) || samples.length === 0 ||
      samples.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error("each task needs positive elapsed-duration samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Each second of waiting subtracts one second from the expected duration within the lane.
function nextTask(pending, now) {
  const score = task => task.duration - Math.max(0, now - task.enqueuedAt);
  pending.sort((a, b) => a.rank - b.rank || score(a) - score(b) ||
    a.enqueuedAt - b.enqueuedAt || a.index - b.index);
  return pending.shift();
}

// The caller supplies its dispatch transport and exact start/completion observers.
export async function dispatchOrdered(tasks, durations, { capacity, dispatch, started, completed, now = Date.now }) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be positive");
  const pending = tasks.map((task, index) => {
    const rank = lanes.indexOf(task.lane);
    if (rank < 0 || !Number.isFinite(task.enqueuedAt)) throw new Error("invalid queued task");
    return { ...task, rank, index, duration: expectedDuration(durations[task.family]) };
  });
  const active = new Map();
  const finished = [];
  const settleNext = async () => {
    const outcome = await Promise.race(active.values());
    active.delete(outcome.request);
    if (!outcome.ok) throw outcome.error;
    finished.push(outcome.request);
  };

  try {
    while (pending.length) {
      if (active.size === capacity) await settleNext();
      const task = nextTask(pending, now());
      const request = await dispatch(task);
      if (active.has(request)) throw new Error("duplicate dispatch receipt");
      active.set(request, Promise.resolve().then(() => completed(request)).then(
        () => ({ request, ok: true }),
        error => ({ request, ok: false, error }),
      ));
      // Observe acceptance before sending another request that GitHub could place ahead of it.
      await started(request);
    }
    while (active.size) await settleNext();
  } catch (error) {
    await Promise.all(active.values());
    throw error;
  }
  return finished;
}
