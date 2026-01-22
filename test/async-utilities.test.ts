/**
 * @fileoverview Tests for async utility patterns
 *
 * Tests Promise utilities, async iterators, concurrent execution,
 * and other async patterns used in the application.
 */

import { describe, it, expect, vi } from 'vitest';

describe('Async Utilities', () => {
  describe('Promise.all Patterns', () => {
    it('should resolve all promises', async () => {
      const results = await Promise.all([
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3),
      ]);
      expect(results).toEqual([1, 2, 3]);
    });

    it('should reject on any failure', async () => {
      const promise = Promise.all([
        Promise.resolve(1),
        Promise.reject(new Error('fail')),
        Promise.resolve(3),
      ]);
      await expect(promise).rejects.toThrow('fail');
    });

    it('should handle empty array', async () => {
      const results = await Promise.all([]);
      expect(results).toEqual([]);
    });
  });

  describe('Promise.allSettled Patterns', () => {
    it('should return all results', async () => {
      const results = await Promise.allSettled([
        Promise.resolve(1),
        Promise.reject(new Error('fail')),
        Promise.resolve(3),
      ]);

      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1]).toMatchObject({ status: 'rejected' });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });

    it('should separate successful and failed results', async () => {
      const results = await Promise.allSettled([
        Promise.resolve(1),
        Promise.reject(new Error('fail')),
        Promise.resolve(3),
      ]);

      const successes = results
        .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
        .map(r => r.value);
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason);

      expect(successes).toEqual([1, 3]);
      expect(failures).toHaveLength(1);
    });
  });

  describe('Promise.race Patterns', () => {
    it('should return first resolved', async () => {
      const result = await Promise.race([
        new Promise(resolve => setTimeout(() => resolve('slow'), 100)),
        Promise.resolve('fast'),
      ]);
      expect(result).toBe('fast');
    });

    it('should reject if first is rejected', async () => {
      const promise = Promise.race([
        Promise.reject(new Error('first')),
        new Promise(resolve => setTimeout(() => resolve('slow'), 100)),
      ]);
      await expect(promise).rejects.toThrow('first');
    });
  });

  describe('Promise.any Patterns', () => {
    it('should return first fulfilled', async () => {
      const result = await Promise.any([
        Promise.reject(new Error('fail1')),
        Promise.resolve('success'),
        Promise.reject(new Error('fail2')),
      ]);
      expect(result).toBe('success');
    });

    it('should reject if all fail', async () => {
      const promise = Promise.any([
        Promise.reject(new Error('fail1')),
        Promise.reject(new Error('fail2')),
      ]);
      await expect(promise).rejects.toBeInstanceOf(AggregateError);
    });
  });

  describe('Sequential Execution', () => {
    const sequential = async <T, R>(
      items: T[],
      fn: (item: T, index: number) => Promise<R>
    ): Promise<R[]> => {
      const results: R[] = [];
      for (let i = 0; i < items.length; i++) {
        results.push(await fn(items[i], i));
      }
      return results;
    };

    it('should execute in order', async () => {
      const order: number[] = [];
      await sequential([1, 2, 3], async (n) => {
        order.push(n);
        return n;
      });
      expect(order).toEqual([1, 2, 3]);
    });

    it('should return results in order', async () => {
      const results = await sequential([1, 2, 3], async (n) => n * 2);
      expect(results).toEqual([2, 4, 6]);
    });

    it('should stop on error', async () => {
      const executed: number[] = [];
      const promise = sequential([1, 2, 3], async (n) => {
        executed.push(n);
        if (n === 2) throw new Error('stop');
        return n;
      });
      await expect(promise).rejects.toThrow('stop');
      expect(executed).toEqual([1, 2]);
    });
  });

  describe('Parallel with Limit', () => {
    const parallelLimit = async <T, R>(
      items: T[],
      limit: number,
      fn: (item: T) => Promise<R>
    ): Promise<R[]> => {
      const results: R[] = new Array(items.length);
      let index = 0;

      const worker = async () => {
        while (index < items.length) {
          const currentIndex = index++;
          results[currentIndex] = await fn(items[currentIndex]);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => worker())
      );

      return results;
    };

    it('should process all items', async () => {
      const results = await parallelLimit([1, 2, 3, 4, 5], 2, async (n) => n * 2);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should limit concurrency', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      await parallelLimit([1, 2, 3, 4, 5], 2, async (n) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 10));
        concurrent--;
        return n;
      });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should handle empty array', async () => {
      const results = await parallelLimit([], 2, async (n: number) => n);
      expect(results).toEqual([]);
    });
  });

  describe('Async Map', () => {
    const asyncMap = async <T, R>(
      items: T[],
      fn: (item: T, index: number) => Promise<R>
    ): Promise<R[]> => {
      return Promise.all(items.map(fn));
    };

    it('should map async functions', async () => {
      const results = await asyncMap([1, 2, 3], async (n) => n * 2);
      expect(results).toEqual([2, 4, 6]);
    });

    it('should provide index', async () => {
      const results = await asyncMap(['a', 'b', 'c'], async (_, i) => i);
      expect(results).toEqual([0, 1, 2]);
    });
  });

  describe('Async Filter', () => {
    const asyncFilter = async <T>(
      items: T[],
      predicate: (item: T) => Promise<boolean>
    ): Promise<T[]> => {
      const results = await Promise.all(
        items.map(async (item) => ({ item, keep: await predicate(item) }))
      );
      return results.filter(r => r.keep).map(r => r.item);
    };

    it('should filter with async predicate', async () => {
      const results = await asyncFilter([1, 2, 3, 4, 5], async (n) => n % 2 === 0);
      expect(results).toEqual([2, 4]);
    });

    it('should handle empty result', async () => {
      const results = await asyncFilter([1, 3, 5], async (n) => n % 2 === 0);
      expect(results).toEqual([]);
    });
  });

  describe('Async Find', () => {
    const asyncFind = async <T>(
      items: T[],
      predicate: (item: T) => Promise<boolean>
    ): Promise<T | undefined> => {
      for (const item of items) {
        if (await predicate(item)) {
          return item;
        }
      }
      return undefined;
    };

    it('should find first match', async () => {
      const result = await asyncFind([1, 2, 3, 4, 5], async (n) => n > 3);
      expect(result).toBe(4);
    });

    it('should return undefined if not found', async () => {
      const result = await asyncFind([1, 2, 3], async (n) => n > 10);
      expect(result).toBeUndefined();
    });

    it('should short-circuit on first match', async () => {
      const checked: number[] = [];
      await asyncFind([1, 2, 3, 4, 5], async (n) => {
        checked.push(n);
        return n === 3;
      });
      expect(checked).toEqual([1, 2, 3]);
    });
  });

  describe('Async Some/Every', () => {
    const asyncSome = async <T>(
      items: T[],
      predicate: (item: T) => Promise<boolean>
    ): Promise<boolean> => {
      for (const item of items) {
        if (await predicate(item)) return true;
      }
      return false;
    };

    const asyncEvery = async <T>(
      items: T[],
      predicate: (item: T) => Promise<boolean>
    ): Promise<boolean> => {
      for (const item of items) {
        if (!(await predicate(item))) return false;
      }
      return true;
    };

    it('should return true if some match', async () => {
      const result = await asyncSome([1, 2, 3], async (n) => n === 2);
      expect(result).toBe(true);
    });

    it('should return false if none match', async () => {
      const result = await asyncSome([1, 2, 3], async (n) => n === 5);
      expect(result).toBe(false);
    });

    it('should return true if all match', async () => {
      const result = await asyncEvery([2, 4, 6], async (n) => n % 2 === 0);
      expect(result).toBe(true);
    });

    it('should return false if any fails', async () => {
      const result = await asyncEvery([2, 3, 6], async (n) => n % 2 === 0);
      expect(result).toBe(false);
    });
  });

  describe('Async Reduce', () => {
    const asyncReduce = async <T, R>(
      items: T[],
      fn: (acc: R, item: T, index: number) => Promise<R>,
      initial: R
    ): Promise<R> => {
      let acc = initial;
      for (let i = 0; i < items.length; i++) {
        acc = await fn(acc, items[i], i);
      }
      return acc;
    };

    it('should reduce with async function', async () => {
      const result = await asyncReduce(
        [1, 2, 3],
        async (acc, n) => acc + n,
        0
      );
      expect(result).toBe(6);
    });

    it('should provide index', async () => {
      const indices: number[] = [];
      await asyncReduce(
        ['a', 'b', 'c'],
        async (acc, _, i) => {
          indices.push(i);
          return acc;
        },
        0
      );
      expect(indices).toEqual([0, 1, 2]);
    });
  });

  describe('Deferred Promise', () => {
    interface Deferred<T> {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason: unknown) => void;
    }

    const createDeferred = <T>(): Deferred<T> => {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;

      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });

      return { promise, resolve, reject };
    };

    it('should resolve externally', async () => {
      const deferred = createDeferred<number>();
      deferred.resolve(42);
      await expect(deferred.promise).resolves.toBe(42);
    });

    it('should reject externally', async () => {
      const deferred = createDeferred<number>();
      deferred.reject(new Error('fail'));
      await expect(deferred.promise).rejects.toThrow('fail');
    });
  });

  describe('Lazy Promise', () => {
    const lazyPromise = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
      let cached: Promise<T> | null = null;
      return () => {
        if (!cached) {
          cached = fn();
        }
        return cached;
      };
    };

    it('should only execute once', async () => {
      const fn = vi.fn().mockResolvedValue(42);
      const lazy = lazyPromise(fn);

      await lazy();
      await lazy();
      await lazy();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should return same result', async () => {
      const lazy = lazyPromise(async () => Math.random());

      const result1 = await lazy();
      const result2 = await lazy();

      expect(result1).toBe(result2);
    });
  });

  describe('Mutex', () => {
    class Mutex {
      private locked = false;
      private waitQueue: (() => void)[] = [];

      async acquire(): Promise<void> {
        if (!this.locked) {
          this.locked = true;
          return;
        }

        return new Promise<void>((resolve) => {
          this.waitQueue.push(resolve);
        });
      }

      release(): void {
        if (this.waitQueue.length > 0) {
          const next = this.waitQueue.shift()!;
          next();
        } else {
          this.locked = false;
        }
      }

      async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
          return await fn();
        } finally {
          this.release();
        }
      }

      isLocked(): boolean {
        return this.locked;
      }
    }

    it('should acquire and release', async () => {
      const mutex = new Mutex();
      await mutex.acquire();
      expect(mutex.isLocked()).toBe(true);
      mutex.release();
      expect(mutex.isLocked()).toBe(false);
    });

    it('should serialize access', async () => {
      const mutex = new Mutex();
      const log: string[] = [];

      const task1 = mutex.withLock(async () => {
        log.push('start1');
        await new Promise(r => setTimeout(r, 10));
        log.push('end1');
      });

      const task2 = mutex.withLock(async () => {
        log.push('start2');
        await new Promise(r => setTimeout(r, 10));
        log.push('end2');
      });

      await Promise.all([task1, task2]);

      expect(log).toEqual(['start1', 'end1', 'start2', 'end2']);
    });
  });

  describe('Semaphore', () => {
    class Semaphore {
      private count: number;
      private waitQueue: (() => void)[] = [];

      constructor(count: number) {
        this.count = count;
      }

      async acquire(): Promise<void> {
        if (this.count > 0) {
          this.count--;
          return;
        }

        return new Promise<void>((resolve) => {
          this.waitQueue.push(resolve);
        });
      }

      release(): void {
        if (this.waitQueue.length > 0) {
          const next = this.waitQueue.shift()!;
          next();
        } else {
          this.count++;
        }
      }

      getAvailable(): number {
        return this.count;
      }
    }

    it('should allow multiple acquisitions', async () => {
      const sem = new Semaphore(3);
      await sem.acquire();
      await sem.acquire();
      expect(sem.getAvailable()).toBe(1);
    });

    it('should block when exhausted', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      let acquired = false;
      const promise = sem.acquire().then(() => {
        acquired = true;
      });

      await new Promise(r => setTimeout(r, 10));
      expect(acquired).toBe(false);

      sem.release();
      await promise;
      expect(acquired).toBe(true);
    });

    it('should release properly', async () => {
      const sem = new Semaphore(2);
      await sem.acquire();
      await sem.acquire();
      expect(sem.getAvailable()).toBe(0);

      sem.release();
      sem.release();
      expect(sem.getAvailable()).toBe(2);
    });
  });

  describe('Async Queue', () => {
    class AsyncQueue<T> {
      private items: T[] = [];
      private waiters: ((item: T) => void)[] = [];

      push(item: T): void {
        if (this.waiters.length > 0) {
          const waiter = this.waiters.shift()!;
          waiter(item);
        } else {
          this.items.push(item);
        }
      }

      async pop(): Promise<T> {
        if (this.items.length > 0) {
          return this.items.shift()!;
        }

        return new Promise<T>((resolve) => {
          this.waiters.push(resolve);
        });
      }

      get size(): number {
        return this.items.length;
      }

      get waiting(): number {
        return this.waiters.length;
      }
    }

    it('should pop available items', async () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);

      expect(await queue.pop()).toBe(1);
      expect(await queue.pop()).toBe(2);
    });

    it('should wait for items', async () => {
      const queue = new AsyncQueue<number>();

      let received: number | null = null;
      const promise = queue.pop().then((n) => {
        received = n;
      });

      expect(queue.waiting).toBe(1);
      queue.push(42);

      await promise;
      expect(received).toBe(42);
    });
  });

  describe('Cancellation Token', () => {
    class CancellationToken {
      private cancelled = false;
      private callbacks: (() => void)[] = [];

      cancel(): void {
        this.cancelled = true;
        this.callbacks.forEach(cb => cb());
        this.callbacks = [];
      }

      isCancelled(): boolean {
        return this.cancelled;
      }

      onCancel(callback: () => void): void {
        if (this.cancelled) {
          callback();
        } else {
          this.callbacks.push(callback);
        }
      }

      throwIfCancelled(): void {
        if (this.cancelled) {
          throw new Error('Operation cancelled');
        }
      }
    }

    it('should track cancellation state', () => {
      const token = new CancellationToken();
      expect(token.isCancelled()).toBe(false);
      token.cancel();
      expect(token.isCancelled()).toBe(true);
    });

    it('should call callbacks on cancel', () => {
      const token = new CancellationToken();
      const callback = vi.fn();

      token.onCancel(callback);
      expect(callback).not.toHaveBeenCalled();

      token.cancel();
      expect(callback).toHaveBeenCalled();
    });

    it('should call callback immediately if already cancelled', () => {
      const token = new CancellationToken();
      token.cancel();

      const callback = vi.fn();
      token.onCancel(callback);

      expect(callback).toHaveBeenCalled();
    });

    it('should throw if cancelled', () => {
      const token = new CancellationToken();
      token.cancel();

      expect(() => token.throwIfCancelled()).toThrow('Operation cancelled');
    });
  });

  describe('Async Pool', () => {
    const asyncPool = async <T, R>(
      items: T[],
      concurrency: number,
      iteratee: (item: T) => Promise<R>
    ): Promise<R[]> => {
      const results: R[] = new Array(items.length);
      let currentIndex = 0;

      const worker = async (): Promise<void> => {
        while (currentIndex < items.length) {
          const index = currentIndex++;
          results[index] = await iteratee(items[index]);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, worker)
      );

      return results;
    };

    it('should process all items', async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await asyncPool(items, 2, async (n) => n * 2);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should handle single concurrency', async () => {
      const items = [1, 2, 3];
      const order: number[] = [];

      await asyncPool(items, 1, async (n) => {
        order.push(n);
        return n;
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it('should handle high concurrency', async () => {
      const items = [1, 2, 3];
      const results = await asyncPool(items, 10, async (n) => n);
      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe('Retry Until', () => {
    const retryUntil = async <T>(
      fn: () => Promise<T>,
      predicate: (result: T) => boolean,
      maxAttempts: number,
      delay: number
    ): Promise<T> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await fn();
        if (predicate(result)) {
          return result;
        }
        if (attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw new Error('Max attempts exceeded');
    };

    it('should return when predicate passes', async () => {
      let count = 0;
      const result = await retryUntil(
        async () => ++count,
        (n) => n >= 3,
        5,
        0
      );
      expect(result).toBe(3);
    });

    it('should throw when max attempts exceeded', async () => {
      const promise = retryUntil(
        async () => 1,
        () => false,
        3,
        0
      );
      await expect(promise).rejects.toThrow('Max attempts exceeded');
    });
  });
});
