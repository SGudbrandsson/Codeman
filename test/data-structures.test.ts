/**
 * @fileoverview Tests for data structure utilities
 *
 * Tests various data structure patterns like LRU cache, priority queue,
 * ring buffer, and other utilities used in the application.
 */

import { describe, it, expect } from 'vitest';

describe('Data Structures', () => {
  describe('LRU Cache', () => {
    class LRUCache<K, V> {
      private cache: Map<K, V> = new Map();
      private capacity: number;

      constructor(capacity: number) {
        this.capacity = capacity;
      }

      get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key)!;
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
      }

      set(key: K, value: V): void {
        if (this.cache.has(key)) {
          this.cache.delete(key);
        } else if (this.cache.size >= this.capacity) {
          // Remove oldest (first key)
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
      }

      has(key: K): boolean {
        return this.cache.has(key);
      }

      delete(key: K): boolean {
        return this.cache.delete(key);
      }

      clear(): void {
        this.cache.clear();
      }

      get size(): number {
        return this.cache.size;
      }

      keys(): K[] {
        return Array.from(this.cache.keys());
      }
    }

    it('should store and retrieve values', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    it('should evict oldest entry when full', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // Should evict 'a'
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });

    it('should update recently used on get', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // Touch 'a'
      cache.set('c', 3); // Should evict 'b', not 'a'
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
    });

    it('should report correct size', () => {
      const cache = new LRUCache<string, number>(5);
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });

    it('should clear all entries', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });

    it('should delete specific entries', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.delete('a');
      expect(cache.has('a')).toBe(false);
    });

    it('should check existence', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });

    it('should list keys', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.keys()).toEqual(['a', 'b']);
    });
  });

  describe('Priority Queue', () => {
    class PriorityQueue<T> {
      private items: { value: T; priority: number }[] = [];

      enqueue(value: T, priority: number): void {
        const item = { value, priority };
        let added = false;
        for (let i = 0; i < this.items.length; i++) {
          if (priority < this.items[i].priority) {
            this.items.splice(i, 0, item);
            added = true;
            break;
          }
        }
        if (!added) {
          this.items.push(item);
        }
      }

      dequeue(): T | undefined {
        return this.items.shift()?.value;
      }

      peek(): T | undefined {
        return this.items[0]?.value;
      }

      isEmpty(): boolean {
        return this.items.length === 0;
      }

      get size(): number {
        return this.items.length;
      }

      clear(): void {
        this.items = [];
      }
    }

    it('should dequeue in priority order', () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue('low', 10);
      pq.enqueue('high', 1);
      pq.enqueue('medium', 5);

      expect(pq.dequeue()).toBe('high');
      expect(pq.dequeue()).toBe('medium');
      expect(pq.dequeue()).toBe('low');
    });

    it('should peek without removing', () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue('item', 1);
      expect(pq.peek()).toBe('item');
      expect(pq.size).toBe(1);
    });

    it('should report empty state', () => {
      const pq = new PriorityQueue<string>();
      expect(pq.isEmpty()).toBe(true);
      pq.enqueue('item', 1);
      expect(pq.isEmpty()).toBe(false);
      pq.dequeue();
      expect(pq.isEmpty()).toBe(true);
    });

    it('should handle same priority', () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue('first', 1);
      pq.enqueue('second', 1);
      expect(pq.dequeue()).toBe('first');
      expect(pq.dequeue()).toBe('second');
    });

    it('should clear all items', () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue('a', 1);
      pq.enqueue('b', 2);
      pq.clear();
      expect(pq.isEmpty()).toBe(true);
    });
  });

  describe('Ring Buffer', () => {
    class RingBuffer<T> {
      private buffer: (T | undefined)[];
      private head = 0;
      private tail = 0;
      private count = 0;
      private capacity: number;

      constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
      }

      push(item: T): T | undefined {
        let evicted: T | undefined;
        if (this.count === this.capacity) {
          evicted = this.buffer[this.head];
          this.head = (this.head + 1) % this.capacity;
        } else {
          this.count++;
        }
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        return evicted;
      }

      shift(): T | undefined {
        if (this.count === 0) return undefined;
        const item = this.buffer[this.head];
        this.buffer[this.head] = undefined;
        this.head = (this.head + 1) % this.capacity;
        this.count--;
        return item;
      }

      peek(): T | undefined {
        if (this.count === 0) return undefined;
        return this.buffer[this.head];
      }

      get size(): number {
        return this.count;
      }

      isFull(): boolean {
        return this.count === this.capacity;
      }

      isEmpty(): boolean {
        return this.count === 0;
      }

      toArray(): T[] {
        const result: T[] = [];
        for (let i = 0; i < this.count; i++) {
          const idx = (this.head + i) % this.capacity;
          result.push(this.buffer[idx]!);
        }
        return result;
      }

      clear(): void {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this.tail = 0;
        this.count = 0;
      }
    }

    it('should add and remove items', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      expect(rb.shift()).toBe(1);
      expect(rb.shift()).toBe(2);
    });

    it('should wrap around', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.shift(); // Remove 1
      rb.push(4); // Should wrap
      expect(rb.toArray()).toEqual([2, 3, 4]);
    });

    it('should evict oldest when full', () => {
      const rb = new RingBuffer<number>(2);
      rb.push(1);
      rb.push(2);
      const evicted = rb.push(3);
      expect(evicted).toBe(1);
      expect(rb.toArray()).toEqual([2, 3]);
    });

    it('should peek without removing', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      expect(rb.peek()).toBe(1);
      expect(rb.size).toBe(1);
    });

    it('should report full state', () => {
      const rb = new RingBuffer<number>(2);
      expect(rb.isFull()).toBe(false);
      rb.push(1);
      rb.push(2);
      expect(rb.isFull()).toBe(true);
    });

    it('should convert to array', () => {
      const rb = new RingBuffer<number>(5);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.toArray()).toEqual([1, 2, 3]);
    });

    it('should clear', () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.clear();
      expect(rb.isEmpty()).toBe(true);
      expect(rb.size).toBe(0);
    });
  });

  describe('Stack', () => {
    class Stack<T> {
      private items: T[] = [];
      private maxSize: number;

      constructor(maxSize: number = Infinity) {
        this.maxSize = maxSize;
      }

      push(item: T): boolean {
        if (this.items.length >= this.maxSize) return false;
        this.items.push(item);
        return true;
      }

      pop(): T | undefined {
        return this.items.pop();
      }

      peek(): T | undefined {
        return this.items[this.items.length - 1];
      }

      get size(): number {
        return this.items.length;
      }

      isEmpty(): boolean {
        return this.items.length === 0;
      }

      isFull(): boolean {
        return this.items.length >= this.maxSize;
      }

      clear(): void {
        this.items = [];
      }

      toArray(): T[] {
        return [...this.items];
      }
    }

    it('should push and pop in LIFO order', () => {
      const stack = new Stack<number>();
      stack.push(1);
      stack.push(2);
      stack.push(3);
      expect(stack.pop()).toBe(3);
      expect(stack.pop()).toBe(2);
      expect(stack.pop()).toBe(1);
    });

    it('should peek without removing', () => {
      const stack = new Stack<number>();
      stack.push(1);
      expect(stack.peek()).toBe(1);
      expect(stack.size).toBe(1);
    });

    it('should respect max size', () => {
      const stack = new Stack<number>(2);
      expect(stack.push(1)).toBe(true);
      expect(stack.push(2)).toBe(true);
      expect(stack.push(3)).toBe(false);
      expect(stack.size).toBe(2);
    });

    it('should report empty state', () => {
      const stack = new Stack<number>();
      expect(stack.isEmpty()).toBe(true);
      stack.push(1);
      expect(stack.isEmpty()).toBe(false);
    });

    it('should report full state', () => {
      const stack = new Stack<number>(2);
      expect(stack.isFull()).toBe(false);
      stack.push(1);
      stack.push(2);
      expect(stack.isFull()).toBe(true);
    });
  });

  describe('Deque (Double-Ended Queue)', () => {
    class Deque<T> {
      private items: T[] = [];

      pushFront(item: T): void {
        this.items.unshift(item);
      }

      pushBack(item: T): void {
        this.items.push(item);
      }

      popFront(): T | undefined {
        return this.items.shift();
      }

      popBack(): T | undefined {
        return this.items.pop();
      }

      peekFront(): T | undefined {
        return this.items[0];
      }

      peekBack(): T | undefined {
        return this.items[this.items.length - 1];
      }

      get size(): number {
        return this.items.length;
      }

      isEmpty(): boolean {
        return this.items.length === 0;
      }

      clear(): void {
        this.items = [];
      }

      toArray(): T[] {
        return [...this.items];
      }
    }

    it('should add to front and back', () => {
      const dq = new Deque<number>();
      dq.pushFront(1);
      dq.pushBack(2);
      dq.pushFront(0);
      expect(dq.toArray()).toEqual([0, 1, 2]);
    });

    it('should remove from front and back', () => {
      const dq = new Deque<number>();
      dq.pushBack(1);
      dq.pushBack(2);
      dq.pushBack(3);
      expect(dq.popFront()).toBe(1);
      expect(dq.popBack()).toBe(3);
      expect(dq.toArray()).toEqual([2]);
    });

    it('should peek front and back', () => {
      const dq = new Deque<number>();
      dq.pushBack(1);
      dq.pushBack(2);
      dq.pushBack(3);
      expect(dq.peekFront()).toBe(1);
      expect(dq.peekBack()).toBe(3);
      expect(dq.size).toBe(3);
    });
  });

  describe('Set Operations', () => {
    const union = <T>(a: Set<T>, b: Set<T>): Set<T> => {
      return new Set([...a, ...b]);
    };

    const intersection = <T>(a: Set<T>, b: Set<T>): Set<T> => {
      return new Set([...a].filter(x => b.has(x)));
    };

    const difference = <T>(a: Set<T>, b: Set<T>): Set<T> => {
      return new Set([...a].filter(x => !b.has(x)));
    };

    const symmetricDifference = <T>(a: Set<T>, b: Set<T>): Set<T> => {
      return new Set([...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x))));
    };

    const isSubset = <T>(a: Set<T>, b: Set<T>): boolean => {
      return [...a].every(x => b.has(x));
    };

    it('should compute union', () => {
      const a = new Set([1, 2, 3]);
      const b = new Set([3, 4, 5]);
      expect([...union(a, b)].sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('should compute intersection', () => {
      const a = new Set([1, 2, 3]);
      const b = new Set([2, 3, 4]);
      expect([...intersection(a, b)].sort()).toEqual([2, 3]);
    });

    it('should compute difference', () => {
      const a = new Set([1, 2, 3]);
      const b = new Set([2, 3, 4]);
      expect([...difference(a, b)].sort()).toEqual([1]);
    });

    it('should compute symmetric difference', () => {
      const a = new Set([1, 2, 3]);
      const b = new Set([2, 3, 4]);
      expect([...symmetricDifference(a, b)].sort()).toEqual([1, 4]);
    });

    it('should check subset', () => {
      const a = new Set([1, 2]);
      const b = new Set([1, 2, 3]);
      expect(isSubset(a, b)).toBe(true);
      expect(isSubset(b, a)).toBe(false);
    });
  });

  describe('Trie', () => {
    class TrieNode {
      children: Map<string, TrieNode> = new Map();
      isEndOfWord = false;
    }

    class Trie {
      private root = new TrieNode();

      insert(word: string): void {
        let node = this.root;
        for (const char of word) {
          if (!node.children.has(char)) {
            node.children.set(char, new TrieNode());
          }
          node = node.children.get(char)!;
        }
        node.isEndOfWord = true;
      }

      search(word: string): boolean {
        const node = this.findNode(word);
        return node !== null && node.isEndOfWord;
      }

      startsWith(prefix: string): boolean {
        return this.findNode(prefix) !== null;
      }

      private findNode(prefix: string): TrieNode | null {
        let node = this.root;
        for (const char of prefix) {
          if (!node.children.has(char)) {
            return null;
          }
          node = node.children.get(char)!;
        }
        return node;
      }

      getWordsWithPrefix(prefix: string): string[] {
        const node = this.findNode(prefix);
        if (!node) return [];
        const words: string[] = [];
        this.collectWords(node, prefix, words);
        return words;
      }

      private collectWords(node: TrieNode, prefix: string, words: string[]): void {
        if (node.isEndOfWord) {
          words.push(prefix);
        }
        for (const [char, child] of node.children) {
          this.collectWords(child, prefix + char, words);
        }
      }
    }

    it('should insert and search words', () => {
      const trie = new Trie();
      trie.insert('hello');
      trie.insert('help');
      expect(trie.search('hello')).toBe(true);
      expect(trie.search('help')).toBe(true);
      expect(trie.search('hel')).toBe(false);
    });

    it('should check prefixes', () => {
      const trie = new Trie();
      trie.insert('hello');
      expect(trie.startsWith('hel')).toBe(true);
      expect(trie.startsWith('hello')).toBe(true);
      expect(trie.startsWith('world')).toBe(false);
    });

    it('should get words with prefix', () => {
      const trie = new Trie();
      trie.insert('hello');
      trie.insert('help');
      trie.insert('world');
      const words = trie.getWordsWithPrefix('hel');
      expect(words.sort()).toEqual(['hello', 'help']);
    });
  });

  describe('Sorted Array', () => {
    class SortedArray<T> {
      private items: T[] = [];
      private compareFn: (a: T, b: T) => number;

      constructor(compareFn: (a: T, b: T) => number = (a: T, b: T) => (a as number) - (b as number)) {
        this.compareFn = compareFn;
      }

      insert(item: T): void {
        let left = 0;
        let right = this.items.length;

        while (left < right) {
          const mid = Math.floor((left + right) / 2);
          if (this.compareFn(this.items[mid], item) < 0) {
            left = mid + 1;
          } else {
            right = mid;
          }
        }

        this.items.splice(left, 0, item);
      }

      remove(item: T): boolean {
        const index = this.indexOf(item);
        if (index === -1) return false;
        this.items.splice(index, 1);
        return true;
      }

      indexOf(item: T): number {
        let left = 0;
        let right = this.items.length;

        while (left < right) {
          const mid = Math.floor((left + right) / 2);
          const cmp = this.compareFn(this.items[mid], item);
          if (cmp === 0) return mid;
          if (cmp < 0) {
            left = mid + 1;
          } else {
            right = mid;
          }
        }

        return -1;
      }

      has(item: T): boolean {
        return this.indexOf(item) !== -1;
      }

      get(index: number): T | undefined {
        return this.items[index];
      }

      get size(): number {
        return this.items.length;
      }

      toArray(): T[] {
        return [...this.items];
      }
    }

    it('should maintain sorted order', () => {
      const arr = new SortedArray<number>();
      arr.insert(5);
      arr.insert(2);
      arr.insert(8);
      arr.insert(1);
      expect(arr.toArray()).toEqual([1, 2, 5, 8]);
    });

    it('should find items', () => {
      const arr = new SortedArray<number>();
      arr.insert(1);
      arr.insert(2);
      arr.insert(3);
      expect(arr.has(2)).toBe(true);
      expect(arr.has(4)).toBe(false);
    });

    it('should remove items', () => {
      const arr = new SortedArray<number>();
      arr.insert(1);
      arr.insert(2);
      arr.insert(3);
      arr.remove(2);
      expect(arr.toArray()).toEqual([1, 3]);
    });

    it('should work with custom comparator', () => {
      const arr = new SortedArray<string>((a, b) => a.localeCompare(b));
      arr.insert('banana');
      arr.insert('apple');
      arr.insert('cherry');
      expect(arr.toArray()).toEqual(['apple', 'banana', 'cherry']);
    });
  });

  describe('Counter', () => {
    class Counter<T> {
      private counts: Map<T, number> = new Map();

      increment(key: T, amount: number = 1): number {
        const current = this.counts.get(key) || 0;
        const newCount = current + amount;
        this.counts.set(key, newCount);
        return newCount;
      }

      decrement(key: T, amount: number = 1): number {
        return this.increment(key, -amount);
      }

      get(key: T): number {
        return this.counts.get(key) || 0;
      }

      total(): number {
        let sum = 0;
        for (const count of this.counts.values()) {
          sum += count;
        }
        return sum;
      }

      mostCommon(n?: number): [T, number][] {
        const entries = Array.from(this.counts.entries());
        entries.sort((a, b) => b[1] - a[1]);
        return n ? entries.slice(0, n) : entries;
      }

      keys(): T[] {
        return Array.from(this.counts.keys());
      }

      clear(): void {
        this.counts.clear();
      }
    }

    it('should count items', () => {
      const counter = new Counter<string>();
      counter.increment('a');
      counter.increment('a');
      counter.increment('b');
      expect(counter.get('a')).toBe(2);
      expect(counter.get('b')).toBe(1);
      expect(counter.get('c')).toBe(0);
    });

    it('should decrement counts', () => {
      const counter = new Counter<string>();
      counter.increment('a', 5);
      counter.decrement('a', 2);
      expect(counter.get('a')).toBe(3);
    });

    it('should calculate total', () => {
      const counter = new Counter<string>();
      counter.increment('a', 3);
      counter.increment('b', 2);
      expect(counter.total()).toBe(5);
    });

    it('should get most common', () => {
      const counter = new Counter<string>();
      counter.increment('a', 5);
      counter.increment('b', 3);
      counter.increment('c', 8);
      const top2 = counter.mostCommon(2);
      expect(top2[0][0]).toBe('c');
      expect(top2[1][0]).toBe('a');
    });
  });

  describe('Bidirectional Map', () => {
    class BiMap<K, V> {
      private forward: Map<K, V> = new Map();
      private reverse: Map<V, K> = new Map();

      set(key: K, value: V): void {
        // Remove existing mappings
        if (this.forward.has(key)) {
          this.reverse.delete(this.forward.get(key)!);
        }
        if (this.reverse.has(value)) {
          this.forward.delete(this.reverse.get(value)!);
        }

        this.forward.set(key, value);
        this.reverse.set(value, key);
      }

      get(key: K): V | undefined {
        return this.forward.get(key);
      }

      getKey(value: V): K | undefined {
        return this.reverse.get(value);
      }

      hasKey(key: K): boolean {
        return this.forward.has(key);
      }

      hasValue(value: V): boolean {
        return this.reverse.has(value);
      }

      deleteKey(key: K): boolean {
        const value = this.forward.get(key);
        if (value === undefined) return false;
        this.forward.delete(key);
        this.reverse.delete(value);
        return true;
      }

      deleteValue(value: V): boolean {
        const key = this.reverse.get(value);
        if (key === undefined) return false;
        this.reverse.delete(value);
        this.forward.delete(key);
        return true;
      }

      get size(): number {
        return this.forward.size;
      }

      clear(): void {
        this.forward.clear();
        this.reverse.clear();
      }
    }

    it('should map in both directions', () => {
      const bimap = new BiMap<string, number>();
      bimap.set('one', 1);
      bimap.set('two', 2);
      expect(bimap.get('one')).toBe(1);
      expect(bimap.getKey(2)).toBe('two');
    });

    it('should check existence in both directions', () => {
      const bimap = new BiMap<string, number>();
      bimap.set('one', 1);
      expect(bimap.hasKey('one')).toBe(true);
      expect(bimap.hasValue(1)).toBe(true);
      expect(bimap.hasKey('two')).toBe(false);
      expect(bimap.hasValue(2)).toBe(false);
    });

    it('should delete in both directions', () => {
      const bimap = new BiMap<string, number>();
      bimap.set('one', 1);
      bimap.deleteKey('one');
      expect(bimap.hasKey('one')).toBe(false);
      expect(bimap.hasValue(1)).toBe(false);
    });

    it('should override existing mappings', () => {
      const bimap = new BiMap<string, number>();
      bimap.set('one', 1);
      bimap.set('one', 2); // Override value
      expect(bimap.get('one')).toBe(2);
      expect(bimap.hasValue(1)).toBe(false);
    });
  });

  describe('Default Map', () => {
    class DefaultMap<K, V> {
      private map: Map<K, V> = new Map();
      private defaultFn: () => V;

      constructor(defaultFn: () => V) {
        this.defaultFn = defaultFn;
      }

      get(key: K): V {
        if (!this.map.has(key)) {
          this.map.set(key, this.defaultFn());
        }
        return this.map.get(key)!;
      }

      set(key: K, value: V): void {
        this.map.set(key, value);
      }

      has(key: K): boolean {
        return this.map.has(key);
      }

      delete(key: K): boolean {
        return this.map.delete(key);
      }

      get size(): number {
        return this.map.size;
      }

      keys(): K[] {
        return Array.from(this.map.keys());
      }

      values(): V[] {
        return Array.from(this.map.values());
      }
    }

    it('should return default value for missing keys', () => {
      const map = new DefaultMap<string, number[]>(() => []);
      map.get('list').push(1);
      map.get('list').push(2);
      expect(map.get('list')).toEqual([1, 2]);
    });

    it('should return existing value', () => {
      const map = new DefaultMap<string, number>(() => 0);
      map.set('key', 5);
      expect(map.get('key')).toBe(5);
    });

    it('should create new default for each missing key', () => {
      const map = new DefaultMap<string, number[]>(() => []);
      map.get('a').push(1);
      map.get('b').push(2);
      expect(map.get('a')).toEqual([1]);
      expect(map.get('b')).toEqual([2]);
    });
  });

  describe('MultiMap', () => {
    class MultiMap<K, V> {
      private map: Map<K, V[]> = new Map();

      add(key: K, value: V): void {
        if (!this.map.has(key)) {
          this.map.set(key, []);
        }
        this.map.get(key)!.push(value);
      }

      get(key: K): V[] {
        return this.map.get(key) || [];
      }

      has(key: K): boolean {
        return this.map.has(key);
      }

      delete(key: K): boolean {
        return this.map.delete(key);
      }

      removeValue(key: K, value: V): boolean {
        const values = this.map.get(key);
        if (!values) return false;
        const index = values.indexOf(value);
        if (index === -1) return false;
        values.splice(index, 1);
        if (values.length === 0) {
          this.map.delete(key);
        }
        return true;
      }

      getValueCount(key: K): number {
        return this.map.get(key)?.length || 0;
      }

      get size(): number {
        return this.map.size;
      }

      get totalValues(): number {
        let count = 0;
        for (const values of this.map.values()) {
          count += values.length;
        }
        return count;
      }
    }

    it('should store multiple values per key', () => {
      const mm = new MultiMap<string, number>();
      mm.add('key', 1);
      mm.add('key', 2);
      mm.add('key', 3);
      expect(mm.get('key')).toEqual([1, 2, 3]);
    });

    it('should remove specific values', () => {
      const mm = new MultiMap<string, number>();
      mm.add('key', 1);
      mm.add('key', 2);
      mm.removeValue('key', 1);
      expect(mm.get('key')).toEqual([2]);
    });

    it('should count values per key', () => {
      const mm = new MultiMap<string, number>();
      mm.add('a', 1);
      mm.add('a', 2);
      mm.add('b', 3);
      expect(mm.getValueCount('a')).toBe(2);
      expect(mm.getValueCount('b')).toBe(1);
      expect(mm.getValueCount('c')).toBe(0);
    });

    it('should count total values', () => {
      const mm = new MultiMap<string, number>();
      mm.add('a', 1);
      mm.add('a', 2);
      mm.add('b', 3);
      expect(mm.totalValues).toBe(3);
    });
  });
});
