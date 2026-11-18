/** Serializes saves for one document. Recovery must be recorded before calling update. */
export class SaveQueue<T, Revision> {
  private current: { value: T; number: number } | undefined;
  private saved = 0;
  private next = 0;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  private paused = false;
  private stopped = false;

  constructor(
    private expected: Revision,
    private readonly write: (value: T, expected: Revision) => Promise<Revision>,
    private readonly changed: () => void = () => {},
    private readonly delay = 750,
  ) {}

  get state(): 'saved' | 'pending' | 'saving' | 'failed' {
    return this.failure !== undefined ? 'failed' : this.inFlight ? 'saving' : this.current && this.current.number > this.saved ? 'pending' : 'saved';
  }
  get error(): unknown { return this.failure; }
  get isPaused(): boolean { return this.paused; }

  /** The caller supplies an immutable snapshot and retains recovery independently. */
  update(value: T): void {
    if (this.stopped) throw new Error('Save queue is closed');
    this.current = { value, number: ++this.next };
    this.schedule();
    this.notify();
  }

  private notify(): void {
    try { this.changed(); } catch (error) { console.error('Save queue notification failed', error); }
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failure !== undefined || this.stopped || this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, this.delay);
  }

  /**
   * Stops debounced writes without discarding the pending snapshot. An external change uses
   * this so autosave cannot race the version being compared; resolution resumes or resets.
   * A write already in flight is not cancelled, so callers pause before they resolve.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.notify();
  }

  /** Resumes debounced autosave after the disk version returned to the expected one. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.schedule();
    this.notify();
  }

  /**
   * Adopts an externally resolved document state: the expected revision advances, any stale
   * pending snapshot or failure is dropped, and paused autosave resumes. A write in flight
   * must finish first; resetting during one could adopt a revision it is about to replace.
   */
  reset(expected: Revision): void {
    if (this.stopped) throw new Error('Save queue is closed');
    if (this.inFlight) throw new Error('A save is still in progress');
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.expected = expected;
    this.failure = undefined;
    this.paused = false;
    this.current = undefined;
    this.saved = this.next;
    this.notify();
  }

  /** Saves every revision observed before the queue becomes idle; never clears recovery. */
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Paused autosave must not write: the caller resolves the external change first.
    if (this.paused) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.inFlight = operation;
    const drain = async () => {
      while (this.current && this.current.number > this.saved) {
        const snapshot = this.current;
        this.expected = await this.write(snapshot.value, this.expected);
        this.saved = snapshot.number;
      }
    };
    const finish = () => {
      void drain().then(() => {
        // An update may have arrived between drain becoming idle and this callback.
        if (this.current && this.current.number > this.saved) { finish(); return; }
        this.inFlight = undefined;
        this.notify();
        resolve();
      }, error => {
        // A partial group write can report the revisions that did reach disk. Keep the
        // queue's expected revision in step so an explicit retry does not re-conflict with
        // this process's own successful member write.
        const expected = (error as { expected?: Revision } | null)?.expected;
        if (expected !== undefined) this.expected = expected;
        this.failure = error ?? new Error('Save failed');
        this.inFlight = undefined;
        this.notify();
        reject(this.failure);
      });
    };
    this.notify();
    finish();
    return operation;
  }

  /** Explicit retry flushes with the expected revision adopted from the last reported write state; conflicts cannot silently overwrite. */
  async retry(): Promise<void> {
    if (this.inFlight) { try { await this.inFlight; } catch { /* Retry the failed write below. */ } }
    this.failure = undefined;
    this.notify();
    return this.flush();
  }

  /** Stop accepting edits and flush. Repeated calls share an active flush; failures remain until retry. */
  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
