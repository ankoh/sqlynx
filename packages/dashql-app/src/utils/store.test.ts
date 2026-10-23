import { describe, expect, it, vi } from 'vitest';

import { Store, UpdateQueue } from './store.js';

describe('store', () => {
    it('runs every updater exactly once and notifies after changes', () => {
        const store = new Store(1);
        const listener = vi.fn();
        store.subscribe(listener);
        const updater = vi.fn((value: number) => value + 1);
        store.update(updater);
        expect(updater).toHaveBeenCalledOnce();
        expect(store.current).toBe(2);
        expect(listener).toHaveBeenCalledOnce();
        store.update(value => value);
        expect(listener).toHaveBeenCalledOnce();
    });
});

describe('update queue', () => {
    it('applies the updates of a task in one store update and in order', async () => {
        const store = new Store<string[]>([]);
        const listener = vi.fn();
        store.subscribe(listener);
        const queue = new UpdateQueue(store);
        queue.push(values => [...values, 'a']);
        queue.push(values => [...values, 'b']);
        expect(store.current).toEqual([]);
        await Promise.resolve();
        expect(store.current).toEqual(['a', 'b']);
        expect(listener).toHaveBeenCalledOnce();
    });

    it('applies updates that wait for a frame before an update that does not wait', () => {
        const store = new Store<string[]>([]);
        const queue = new UpdateQueue(store);
        queue.push(values => [...values, 'progress'], true);
        expect(store.current).toEqual([]);
        queue.push(values => [...values, 'finished']);
        expect(store.current).toEqual(['progress', 'finished']);
        queue.dispose();
    });

    it('drops pending updates when disposed', async () => {
        const store = new Store<string[]>([]);
        const queue = new UpdateQueue(store);
        queue.push(values => [...values, 'progress'], true);
        queue.dispose();
        await new Promise(resolve => requestAnimationFrame(resolve));
        expect(store.current).toEqual([]);
    });
});
