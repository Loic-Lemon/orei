import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveQueue } from '../src/save-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); });

describe('SaveQueue debounce edges', () => {
  it('restarts the debounce on every update so a burst fires once after the last edit', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 750);
    queue.update('one');
    await vi.advanceTimersByTimeAsync(700);
    queue.update('two');
    await vi.advanceTimersByTimeAsync(740);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(write).toHaveBeenCalledExactlyOnceWith('two', 'disk-0');
    await queue.dispose();
  });

  it('explicit flush cancels the pending debounce and never fires it afterwards', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 750);
    queue.update('one');
    await vi.advanceTimersByTimeAsync(749);
    await queue.flush();
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });

  it('a timer firing during an in-flight write does not start a second flush; the update is drained instead', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('disk-2');
    const queue = new SaveQueue('disk-0', write, () => {}, 750);
    queue.update('one');
    await vi.advanceTimersByTimeAsync(750);
    queue.update('two');
    await vi.advanceTimersByTimeAsync(750);
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve('disk-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(write.mock.calls).toEqual([['one', 'disk-0'], ['two', 'disk-1']]);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });

  it('chains revisions across consecutive debounced save cycles', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValueOnce('disk-1').mockResolvedValueOnce('disk-2');
    const queue = new SaveQueue('disk-0', write, () => {}, 750);
    queue.update('one');
    await vi.advanceTimersByTimeAsync(750);
    queue.update('two');
    await vi.advanceTimersByTimeAsync(750);
    expect(write.mock.calls).toEqual([['one', 'disk-0'], ['two', 'disk-1']]);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });
});

describe('SaveQueue failure edges', () => {
  it('an update during the failed state schedules nothing until an explicit retry', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 750);
    queue.update('one');
    await vi.advanceTimersByTimeAsync(750);
    first.reject(new Error('conflict'));
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.state).toBe('failed');
    queue.update('two');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);
    await queue.retry();
    expect(write.mock.calls[1]).toEqual(['two', 'disk-0']);
    expect(queue.state).toBe('saved');
    expect(queue.error).toBeUndefined();
    await queue.dispose();
  });

  it('normalizes a falsy rejection into a Save failed error', async () => {
    const write = vi.fn().mockRejectedValueOnce(null).mockResolvedValueOnce('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 10000);
    queue.update('a');
    await expect(queue.flush()).rejects.toThrow('Save failed');
    expect(queue.state).toBe('failed');
    expect(queue.error).toBeInstanceOf(Error);
    await queue.retry();
    expect(write.mock.calls).toEqual([['a', 'disk-0'], ['a', 'disk-0']]);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });

  it('reports failed state transitions through the changed callback', () => {
    const states: string[] = [];
    const first = deferred<string>();
    const write = vi.fn().mockReturnValueOnce(first.promise);
    const queue = new SaveQueue('disk-0', write, () => { states.push(queue.state); }, 750);
    queue.update('a');
    void queue.flush().catch(() => {});
    first.reject(new Error('disk full'));
    return queue.flush().catch(error => {
      expect(error).toBe(queue.error);
      expect(states).toEqual(['pending', 'saving', 'failed']);
    });
  });
});

describe('SaveQueue retry and disposal edges', () => {
  it('retry on a healthy idle queue resolves without writing', async () => {
    const write = vi.fn().mockResolvedValue('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 10000);
    await expect(queue.retry()).resolves.toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    await queue.dispose();
  });

  it('dispose writes a pending debounce immediately without waiting for the delay', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 750);
    queue.update('one');
    await queue.dispose();
    expect(write).toHaveBeenCalledExactlyOnceWith('one', 'disk-0');
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.state).toBe('saved');
  });

  it('dispose with nothing pending stays saved and rejects further edits', async () => {
    const write = vi.fn().mockResolvedValue('disk-1');
    const queue = new SaveQueue('disk-0', write, () => {}, 10000);
    await expect(queue.dispose()).resolves.toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(() => queue.update('too late')).toThrow('closed');
    await expect(queue.dispose()).resolves.toBeUndefined();
    expect(queue.state).toBe('saved');
  });
});
