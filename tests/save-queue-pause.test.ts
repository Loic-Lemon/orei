import { describe, expect, it, vi } from 'vitest';
import { SaveQueue } from '../src/save-queue';

describe('save queue external-change pause and reset', () => {
  it('does not write a pending snapshot while paused and resumes after a reset', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn().mockResolvedValue(10);
      const queue = new SaveQueue<number, number>(1, write, () => {}, 750);
      queue.update(7);
      expect(queue.state).toBe('pending');
      queue.pause();
      await vi.advanceTimersByTimeAsync(5000);
      expect(write).not.toHaveBeenCalled();
      expect(queue.state).toBe('pending');
      await expect(queue.flush()).resolves.toBeUndefined();
      expect(write).not.toHaveBeenCalled();
      // Reloading from disk drops the stale snapshot and adopts the disk revision; the
      // paused state ends with it.
      queue.reset(9);
      expect(queue.state).toBe('saved');
      expect(queue.isPaused).toBe(false);
      queue.update(8);
      await vi.advanceTimersByTimeAsync(750);
      expect(write).toHaveBeenCalledExactlyOnceWith(8, 9);
      await queue.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('drops a pause-time update on reset and saves only later edits', async () => {
    const write = vi.fn().mockResolvedValue('disk-2');
    const queue = new SaveQueue<string, string>('disk-1', write, () => {}, 10000);
    queue.pause();
    queue.update('typing while paused');
    expect(queue.state).toBe('pending');
    queue.reset('disk-2');
    expect(queue.state).toBe('saved');
    expect(write).not.toHaveBeenCalled();
    queue.update('after reload');
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledExactlyOnceWith('after reload', 'disk-2');
    await queue.dispose();
  });

  it('refuses to reset while a write is in flight', async () => {
    let finish!: (value: number) => void;
    const write = vi.fn().mockReturnValue(new Promise<number>(resolve => { finish = resolve; }));
    const queue = new SaveQueue<number, number>(1, write, () => {}, 10000);
    queue.update(7);
    const flushing = queue.flush();
    expect(() => queue.reset(5)).toThrow('in progress');
    finish(2);
    await flushing;
    expect(queue.state).toBe('saved');
    queue.reset(5);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });
});
