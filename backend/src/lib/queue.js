// Concurrency limiter for paid work, so bursts queue instead of hitting OpenAI rate limits.
// onPosition(n) tells each waiting task its place in line (1 = next), and 0 when it starts.
export function createLimiter(concurrency) {
  let running = 0;
  const waiting = [];

  function announce() {
    waiting.forEach((task, index) => task.onPosition?.(index + 1));
  }

  function next() {
    while (running < concurrency && waiting.length) {
      const task = waiting.shift();
      running += 1;
      task.onPosition?.(0);
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          running -= 1;
          next();
        });
    }
    announce();
  }

  return {
    run(fn, onPosition) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, onPosition, resolve, reject });
        next();
      });
    },
    stats: () => ({ running, waiting: waiting.length, concurrency })
  };
}
