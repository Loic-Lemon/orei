import { describe, expect, it, vi } from 'vitest';
import { SaveQueue } from '../src/save-queue';

function deferred<T>() {
  let resolve!: (value:T)=>void;
  let reject!: (reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

describe('named document save queue',()=>{
  it('serializes edits arriving during a save against the resulting disk revision',async()=>{
    const first=deferred<string>();
    const write=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('disk-2');
    const queue=new SaveQueue('disk-0',write,()=>{},10000);
    queue.update('incomplete source');
    const flushing=queue.flush();
    queue.update('newer source');
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve('disk-1');
    await flushing;
    expect(write.mock.calls).toEqual([['incomplete source','disk-0'],['newer source','disk-1']]);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });

  it('pauses after a failed save and retries the latest snapshot with the unchanged expected revision',async()=>{
    const first=deferred<string>();
    const write=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('disk-1');
    const queue=new SaveQueue('disk-0',write,()=>{},10000);
    queue.update('first');
    const flushing=queue.flush();
    queue.update('latest');
    first.reject(new Error('conflict'));
    await expect(flushing).rejects.toThrow('conflict');
    expect(queue.state).toBe('failed');
    await expect(queue.flush()).rejects.toThrow('conflict');
    expect(write).toHaveBeenCalledTimes(1);
    await queue.retry();
    expect(write.mock.calls[1]).toEqual(['latest','disk-0']);
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });

  it('coalesces a burst of edits after the debounce',async()=>{
    vi.useFakeTimers();
    try {
      const write=vi.fn().mockResolvedValue('disk-1');
      const queue=new SaveQueue('disk-0',write,()=>{},750);
      queue.update('one');
      await vi.advanceTimersByTimeAsync(500);
      queue.update('two');
      await vi.advanceTimersByTimeAsync(749);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledExactlyOnceWith('two','disk-0');
      await queue.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('keeps overlapping flush callers waiting for the newest write',async()=>{
    const first=deferred<string>();
    const second=deferred<string>();
    const write=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const queue=new SaveQueue('disk-0',write,()=>{},10000);
    queue.update('one');
    const a=queue.flush();
    const b=queue.flush();
    queue.update('two');
    first.resolve('disk-1');
    await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(2));
    let finished=0;
    void a.then(()=>finished++);
    void b.then(()=>finished++);
    await Promise.resolve();
    expect(finished).toBe(0);
    second.resolve('disk-2');
    await Promise.all([a,b]);
    expect(finished).toBe(2);
    expect(write.mock.calls).toEqual([['one','disk-0'],['two','disk-1']]);
    await queue.dispose();
  });

  it('waits for an in-flight failure before retrying without overlapping writes',async()=>{
    const first=deferred<string>();
    const second=deferred<string>();
    const write=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const queue=new SaveQueue('disk-0',write,()=>{},10000);
    queue.update('one');
    const original=queue.flush();
    const retry=queue.retry();
    queue.update('two');
    expect(write).toHaveBeenCalledTimes(1);
    first.reject(new Error('write failed'));
    await expect(original).rejects.toThrow('write failed');
    await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]).toEqual(['two','disk-0']);
    second.resolve('disk-1');
    await retry;
    await queue.dispose();
  });

  it('flushes on disposal and propagates failures while rejecting further edits',async()=>{
    const pending=deferred<string>();
    const queue=new SaveQueue('disk-0',vi.fn().mockReturnValueOnce(pending.promise),()=>{},10000);
    queue.update('unsaved');
    const closing=queue.dispose();
    expect(()=>queue.update('too late')).toThrow('closed');
    pending.reject(new Error('disk full'));
    await expect(closing).rejects.toThrow('disk full');
    expect(queue.state).toBe('failed');
  });

  it('resynchronizes the expected revision from a partial group failure before retrying',async()=>{
    const partial=Object.assign(new Error('stylesheet failed'),{expected:'disk-1'});
    const write=vi.fn().mockRejectedValueOnce(partial).mockResolvedValueOnce('disk-2');
    const queue=new SaveQueue('disk-0',write,()=>{},10000);
    queue.update('group');
    await expect(queue.flush()).rejects.toThrow('stylesheet failed');
    expect(queue.state).toBe('failed');
    await queue.retry();
    expect(write.mock.calls[1][1]).toBe('disk-1');
    expect(queue.state).toBe('saved');
    await queue.dispose();
  });
});

describe('save queue notification and disposal contract',()=>{
  it('continues draining and settles when notifications throw',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const queue=new SaveQueue('old',vi.fn().mockResolvedValue('new'),()=>{throw new Error('observer');},10000);
      queue.update('content');
      await expect(queue.flush()).resolves.toBeUndefined();
      expect(queue.state).toBe('saved');
      await expect(queue.dispose()).resolves.toBeUndefined();
    } finally { log.mockRestore(); }
  });
  it('shares disposal writes and retains a failure until explicit retry',async()=>{
    const first=deferred<string>();
    const write=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('new');
    const queue=new SaveQueue('old',write,()=>{},10000);
    queue.update('content');
    const a=queue.dispose(), b=queue.dispose();
    first.reject(new Error('disk full'));
    await expect(a).rejects.toThrow('disk full');
    await expect(b).rejects.toThrow('disk full');
    await expect(queue.dispose()).rejects.toThrow('disk full');
    await queue.retry();
    await expect(queue.dispose()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
