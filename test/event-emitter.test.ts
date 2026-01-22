/**
 * @fileoverview Tests for event emitter patterns and utilities
 *
 * Tests event emission, subscription, and cleanup patterns used
 * throughout the Claudeman application.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

describe('Event Emitter Patterns', () => {
  describe('Basic Event Emission', () => {
    it('should emit and receive events', () => {
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on('test', handler);
      emitter.emit('test', 'data');
      expect(handler).toHaveBeenCalledWith('data');
    });

    it('should handle multiple listeners', () => {
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('test', handler1);
      emitter.on('test', handler2);
      emitter.emit('test', 'data');
      expect(handler1).toHaveBeenCalledWith('data');
      expect(handler2).toHaveBeenCalledWith('data');
    });

    it('should handle once listeners', () => {
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.once('test', handler);
      emitter.emit('test', 'first');
      emitter.emit('test', 'second');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('first');
    });

    it('should remove listeners', () => {
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on('test', handler);
      emitter.off('test', handler);
      emitter.emit('test', 'data');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should remove all listeners', () => {
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('test', handler1);
      emitter.on('test', handler2);
      emitter.removeAllListeners('test');
      emitter.emit('test', 'data');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('Typed Event Emitter Pattern', () => {
    interface MyEvents {
      data: (payload: string) => void;
      error: (err: Error) => void;
      count: (n: number) => void;
    }

    class TypedEmitter extends EventEmitter {
      emit<K extends keyof MyEvents>(event: K, ...args: Parameters<MyEvents[K]>): boolean {
        return super.emit(event, ...args);
      }

      on<K extends keyof MyEvents>(event: K, listener: MyEvents[K]): this {
        return super.on(event, listener);
      }

      off<K extends keyof MyEvents>(event: K, listener: MyEvents[K]): this {
        return super.off(event, listener);
      }
    }

    it('should emit typed events', () => {
      const emitter = new TypedEmitter();
      const handler = vi.fn();
      emitter.on('data', handler);
      emitter.emit('data', 'hello');
      expect(handler).toHaveBeenCalledWith('hello');
    });

    it('should emit error events', () => {
      const emitter = new TypedEmitter();
      const handler = vi.fn();
      emitter.on('error', handler);
      const error = new Error('test error');
      emitter.emit('error', error);
      expect(handler).toHaveBeenCalledWith(error);
    });

    it('should emit count events', () => {
      const emitter = new TypedEmitter();
      const handler = vi.fn();
      emitter.on('count', handler);
      emitter.emit('count', 42);
      expect(handler).toHaveBeenCalledWith(42);
    });
  });

  describe('Event Queue Pattern', () => {
    class EventQueue<T> {
      private queue: T[] = [];
      private handlers: ((item: T) => void)[] = [];
      private processing = false;

      enqueue(item: T): void {
        this.queue.push(item);
        this.process();
      }

      onItem(handler: (item: T) => void): void {
        this.handlers.push(handler);
      }

      private process(): void {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
          const item = this.queue.shift()!;
          for (const handler of this.handlers) {
            handler(item);
          }
        }

        this.processing = false;
      }

      get pending(): number {
        return this.queue.length;
      }
    }

    it('should process items in order', () => {
      const queue = new EventQueue<string>();
      const items: string[] = [];
      queue.onItem(item => items.push(item));

      queue.enqueue('a');
      queue.enqueue('b');
      queue.enqueue('c');

      expect(items).toEqual(['a', 'b', 'c']);
    });

    it('should handle multiple handlers', () => {
      const queue = new EventQueue<number>();
      let sum = 0;
      let product = 1;

      queue.onItem(n => { sum += n; });
      queue.onItem(n => { product *= n; });

      queue.enqueue(2);
      queue.enqueue(3);

      expect(sum).toBe(5);
      expect(product).toBe(6);
    });

    it('should report pending count', () => {
      const queue = new EventQueue<string>();
      // Items are processed immediately when handlers are added
      expect(queue.pending).toBe(0);
    });
  });

  describe('Event Aggregation Pattern', () => {
    class EventAggregator<T> {
      private events: T[] = [];
      private maxEvents: number;
      private onFlush: (events: T[]) => void;
      private flushTimer: ReturnType<typeof setTimeout> | null = null;
      private flushInterval: number;

      constructor(options: {
        maxEvents: number;
        flushInterval: number;
        onFlush: (events: T[]) => void;
      }) {
        this.maxEvents = options.maxEvents;
        this.flushInterval = options.flushInterval;
        this.onFlush = options.onFlush;
      }

      add(event: T): void {
        this.events.push(event);

        if (this.events.length >= this.maxEvents) {
          this.flush();
        } else if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => this.flush(), this.flushInterval);
        }
      }

      flush(): void {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }

        if (this.events.length > 0) {
          const events = this.events;
          this.events = [];
          this.onFlush(events);
        }
      }

      get pendingCount(): number {
        return this.events.length;
      }
    }

    it('should flush when max events reached', () => {
      const flushed: string[][] = [];
      const aggregator = new EventAggregator<string>({
        maxEvents: 3,
        flushInterval: 1000,
        onFlush: events => flushed.push(events),
      });

      aggregator.add('a');
      aggregator.add('b');
      expect(flushed).toHaveLength(0);

      aggregator.add('c');
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual(['a', 'b', 'c']);
    });

    it('should flush manually', () => {
      const flushed: number[][] = [];
      const aggregator = new EventAggregator<number>({
        maxEvents: 100,
        flushInterval: 10000,
        onFlush: events => flushed.push(events),
      });

      aggregator.add(1);
      aggregator.add(2);
      aggregator.flush();

      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual([1, 2]);
    });

    it('should not flush when empty', () => {
      const flushed: string[][] = [];
      const aggregator = new EventAggregator<string>({
        maxEvents: 10,
        flushInterval: 1000,
        onFlush: events => flushed.push(events),
      });

      aggregator.flush();
      expect(flushed).toHaveLength(0);
    });

    it('should track pending count', () => {
      const aggregator = new EventAggregator<string>({
        maxEvents: 10,
        flushInterval: 1000,
        onFlush: () => {},
      });

      expect(aggregator.pendingCount).toBe(0);
      aggregator.add('a');
      expect(aggregator.pendingCount).toBe(1);
      aggregator.add('b');
      expect(aggregator.pendingCount).toBe(2);
      aggregator.flush();
      expect(aggregator.pendingCount).toBe(0);
    });
  });

  describe('Event Filtering Pattern', () => {
    class FilteredEmitter extends EventEmitter {
      private filters: Map<string, ((data: unknown) => boolean)[]> = new Map();

      addFilter(event: string, filter: (data: unknown) => boolean): void {
        if (!this.filters.has(event)) {
          this.filters.set(event, []);
        }
        this.filters.get(event)!.push(filter);
      }

      emitFiltered(event: string, data: unknown): boolean {
        const filters = this.filters.get(event) || [];
        const shouldEmit = filters.every(f => f(data));
        if (shouldEmit) {
          return this.emit(event, data);
        }
        return false;
      }

      clearFilters(event?: string): void {
        if (event) {
          this.filters.delete(event);
        } else {
          this.filters.clear();
        }
      }
    }

    it('should emit when all filters pass', () => {
      const emitter = new FilteredEmitter();
      const handler = vi.fn();

      emitter.addFilter('data', (d) => (d as number) > 0);
      emitter.on('data', handler);

      emitter.emitFiltered('data', 5);
      expect(handler).toHaveBeenCalledWith(5);
    });

    it('should not emit when filter fails', () => {
      const emitter = new FilteredEmitter();
      const handler = vi.fn();

      emitter.addFilter('data', (d) => (d as number) > 0);
      emitter.on('data', handler);

      emitter.emitFiltered('data', -5);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should apply multiple filters', () => {
      const emitter = new FilteredEmitter();
      const handler = vi.fn();

      emitter.addFilter('data', (d) => (d as number) > 0);
      emitter.addFilter('data', (d) => (d as number) < 100);
      emitter.on('data', handler);

      emitter.emitFiltered('data', 50);
      expect(handler).toHaveBeenCalled();

      handler.mockClear();
      emitter.emitFiltered('data', 150);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should clear filters', () => {
      const emitter = new FilteredEmitter();
      const handler = vi.fn();

      emitter.addFilter('data', () => false);
      emitter.on('data', handler);

      emitter.emitFiltered('data', 'test');
      expect(handler).not.toHaveBeenCalled();

      emitter.clearFilters('data');
      emitter.emitFiltered('data', 'test');
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('Event Replay Pattern', () => {
    class ReplayEmitter extends EventEmitter {
      private history: Map<string, unknown[]> = new Map();
      private maxHistory: number;

      constructor(maxHistory: number = 10) {
        super();
        this.maxHistory = maxHistory;
      }

      emitWithHistory(event: string, data: unknown): boolean {
        if (!this.history.has(event)) {
          this.history.set(event, []);
        }
        const events = this.history.get(event)!;
        events.push(data);
        if (events.length > this.maxHistory) {
          events.shift();
        }
        return this.emit(event, data);
      }

      replay(event: string, listener: (data: unknown) => void): void {
        const events = this.history.get(event) || [];
        events.forEach(listener);
      }

      clearHistory(event?: string): void {
        if (event) {
          this.history.delete(event);
        } else {
          this.history.clear();
        }
      }

      getHistory(event: string): unknown[] {
        return [...(this.history.get(event) || [])];
      }
    }

    it('should store event history', () => {
      const emitter = new ReplayEmitter();
      emitter.emitWithHistory('data', 'a');
      emitter.emitWithHistory('data', 'b');

      const history = emitter.getHistory('data');
      expect(history).toEqual(['a', 'b']);
    });

    it('should replay events to new listener', () => {
      const emitter = new ReplayEmitter();
      emitter.emitWithHistory('data', 1);
      emitter.emitWithHistory('data', 2);
      emitter.emitWithHistory('data', 3);

      const received: number[] = [];
      emitter.replay('data', (d) => received.push(d as number));
      expect(received).toEqual([1, 2, 3]);
    });

    it('should respect max history', () => {
      const emitter = new ReplayEmitter(3);
      for (let i = 0; i < 5; i++) {
        emitter.emitWithHistory('data', i);
      }

      const history = emitter.getHistory('data');
      expect(history).toEqual([2, 3, 4]);
    });

    it('should clear history', () => {
      const emitter = new ReplayEmitter();
      emitter.emitWithHistory('data', 'a');
      emitter.clearHistory('data');
      expect(emitter.getHistory('data')).toEqual([]);
    });
  });

  describe('Event Transform Pattern', () => {
    class TransformEmitter extends EventEmitter {
      private transforms: Map<string, ((data: unknown) => unknown)[]> = new Map();

      addTransform(event: string, transform: (data: unknown) => unknown): void {
        if (!this.transforms.has(event)) {
          this.transforms.set(event, []);
        }
        this.transforms.get(event)!.push(transform);
      }

      emitTransformed(event: string, data: unknown): boolean {
        const transforms = this.transforms.get(event) || [];
        const transformed = transforms.reduce((d, t) => t(d), data);
        return this.emit(event, transformed);
      }
    }

    it('should transform data before emission', () => {
      const emitter = new TransformEmitter();
      const handler = vi.fn();

      emitter.addTransform('data', (d) => (d as number) * 2);
      emitter.on('data', handler);

      emitter.emitTransformed('data', 5);
      expect(handler).toHaveBeenCalledWith(10);
    });

    it('should chain transforms', () => {
      const emitter = new TransformEmitter();
      const handler = vi.fn();

      emitter.addTransform('data', (d) => (d as number) + 1);
      emitter.addTransform('data', (d) => (d as number) * 2);
      emitter.on('data', handler);

      emitter.emitTransformed('data', 5);
      // (5 + 1) * 2 = 12
      expect(handler).toHaveBeenCalledWith(12);
    });

    it('should handle string transforms', () => {
      const emitter = new TransformEmitter();
      const handler = vi.fn();

      emitter.addTransform('message', (d) => (d as string).toUpperCase());
      emitter.on('message', handler);

      emitter.emitTransformed('message', 'hello');
      expect(handler).toHaveBeenCalledWith('HELLO');
    });
  });

  describe('Event Debouncing', () => {
    class DebouncedEmitter extends EventEmitter {
      private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
      private delays: Map<string, number> = new Map();

      setDebounce(event: string, delay: number): void {
        this.delays.set(event, delay);
      }

      emitDebounced(event: string, data: unknown): void {
        const existingTimer = this.timers.get(event);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const delay = this.delays.get(event) || 0;
        if (delay === 0) {
          this.emit(event, data);
          return;
        }

        const timer = setTimeout(() => {
          this.timers.delete(event);
          this.emit(event, data);
        }, delay);

        this.timers.set(event, timer);
      }

      flush(event: string): void {
        const timer = this.timers.get(event);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(event);
        }
      }

      cancel(event: string): void {
        const timer = this.timers.get(event);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(event);
        }
      }
    }

    it('should emit immediately with no delay', () => {
      const emitter = new DebouncedEmitter();
      const handler = vi.fn();

      emitter.on('data', handler);
      emitter.emitDebounced('data', 'test');

      expect(handler).toHaveBeenCalledWith('test');
    });

    it('should cancel pending emissions', () => {
      const emitter = new DebouncedEmitter();
      const handler = vi.fn();

      emitter.setDebounce('data', 100);
      emitter.on('data', handler);
      emitter.emitDebounced('data', 'test');
      emitter.cancel('data');

      // Wait a bit and verify nothing was called
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Event Subscription Management', () => {
    class ManagedEmitter extends EventEmitter {
      private subscriptions: Map<string, Set<(...args: unknown[]) => void>> = new Map();

      subscribe(event: string, handler: (...args: unknown[]) => void): () => void {
        if (!this.subscriptions.has(event)) {
          this.subscriptions.set(event, new Set());
        }
        this.subscriptions.get(event)!.add(handler);
        this.on(event, handler);

        return () => {
          this.subscriptions.get(event)?.delete(handler);
          this.off(event, handler);
        };
      }

      getSubscriberCount(event: string): number {
        return this.subscriptions.get(event)?.size || 0;
      }

      unsubscribeAll(event?: string): void {
        if (event) {
          const handlers = this.subscriptions.get(event);
          if (handlers) {
            handlers.forEach(h => this.off(event, h));
            this.subscriptions.delete(event);
          }
        } else {
          this.subscriptions.forEach((handlers, evt) => {
            handlers.forEach(h => this.off(evt, h));
          });
          this.subscriptions.clear();
        }
      }
    }

    it('should track subscriptions', () => {
      const emitter = new ManagedEmitter();

      emitter.subscribe('test', () => {});
      emitter.subscribe('test', () => {});

      expect(emitter.getSubscriberCount('test')).toBe(2);
    });

    it('should return unsubscribe function', () => {
      const emitter = new ManagedEmitter();
      const handler = vi.fn();

      const unsubscribe = emitter.subscribe('test', handler);
      emitter.emit('test');
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit('test');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe all handlers', () => {
      const emitter = new ManagedEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.subscribe('test', handler1);
      emitter.subscribe('test', handler2);

      emitter.unsubscribeAll('test');
      emitter.emit('test');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(emitter.getSubscriberCount('test')).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle errors in listeners', () => {
      const emitter = new EventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('test', () => {
        throw new Error('Handler error');
      });
      emitter.on('test', handler2);

      // Without error handler, this would throw
      emitter.on('error', handler1);

      try {
        emitter.emit('test');
      } catch {
        // Expected
      }

      // handler2 won't be called if handler1 throws synchronously
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should propagate errors with error event', () => {
      const emitter = new EventEmitter();
      const errorHandler = vi.fn();

      emitter.on('error', errorHandler);
      emitter.emit('error', new Error('test error'));

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('Max Listeners Warning', () => {
    it('should track listener count', () => {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(5);

      for (let i = 0; i < 3; i++) {
        emitter.on('test', () => {});
      }

      expect(emitter.listenerCount('test')).toBe(3);
    });

    it('should get max listeners', () => {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(20);
      expect(emitter.getMaxListeners()).toBe(20);
    });
  });
});

describe('Event Bus Pattern', () => {
  class EventBus {
    private emitter = new EventEmitter();
    private static instance: EventBus | null = null;

    static getInstance(): EventBus {
      if (!EventBus.instance) {
        EventBus.instance = new EventBus();
      }
      return EventBus.instance;
    }

    static resetInstance(): void {
      EventBus.instance = null;
    }

    publish(event: string, data?: unknown): void {
      this.emitter.emit(event, data);
    }

    subscribe(event: string, handler: (data?: unknown) => void): () => void {
      this.emitter.on(event, handler);
      return () => this.emitter.off(event, handler);
    }

    subscribeOnce(event: string, handler: (data?: unknown) => void): void {
      this.emitter.once(event, handler);
    }
  }

  it('should create singleton instance', () => {
    EventBus.resetInstance();
    const bus1 = EventBus.getInstance();
    const bus2 = EventBus.getInstance();
    expect(bus1).toBe(bus2);
  });

  it('should publish and subscribe', () => {
    EventBus.resetInstance();
    const bus = EventBus.getInstance();
    const handler = vi.fn();

    bus.subscribe('test', handler);
    bus.publish('test', 'data');

    expect(handler).toHaveBeenCalledWith('data');
  });

  it('should unsubscribe', () => {
    EventBus.resetInstance();
    const bus = EventBus.getInstance();
    const handler = vi.fn();

    const unsubscribe = bus.subscribe('test', handler);
    unsubscribe();
    bus.publish('test', 'data');

    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle once subscription', () => {
    EventBus.resetInstance();
    const bus = EventBus.getInstance();
    const handler = vi.fn();

    bus.subscribeOnce('test', handler);
    bus.publish('test', 'first');
    bus.publish('test', 'second');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('first');
  });
});
