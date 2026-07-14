/**
 * Minimal promise concurrency limiter (dependency-free p-limit).
 * Returns a function that queues tasks so at most `max` run at once.
 */
export function pLimit(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`pLimit: concurrency must be a positive integer, got ${max}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active--;
    const run = queue.shift();
    if (run) run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

/** Run `fn` over every item with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  max: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(max);
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}
