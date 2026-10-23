/**
 * Anthropic makes a cache entry readable only once the response that writes it starts
 * streaming, so parallel requests sharing a new prefix would each pay a full write. The first
 * request for a key goes alone; the others wait for its first streamed token, then read.
 *
 * A writer releases on its first token, or on failure, abort or timeout. A failed writer lets
 * the next waiter write instead. Waiters stop waiting on their own abort or after `maxWaitMs`,
 * so the gate can never deadlock. Once a key has streamed it stays warm for this process.
 */
export class ClaudeWarmGate {
  private readonly writers = new Map<string, Promise<boolean>>();
  private readonly warm = new Set<string>();

  constructor(private readonly maxWaitMs = 120_000) {}

  /** Returns `release(streamed)`; call it once the first token arrives, or on any failure. */
  async enter(key: string, signal?: AbortSignal): Promise<(streamed: boolean) => void> {
    for (;;) {
      if (this.warm.has(key)) return () => undefined;
      const writer = this.writers.get(key);
      if (!writer) break;
      const outcome = await this.wait(writer, signal);
      if (outcome !== "failed") return () => undefined;
      // The writer failed before streaming: the next waiter to resume becomes the writer.
    }
    let settle!: (streamed: boolean) => void;
    const done = new Promise<boolean>((resolve) => (settle = resolve));
    this.writers.set(key, done);
    let released = false;
    return (streamed) => {
      if (released) return;
      released = true;
      this.writers.delete(key);
      if (streamed) this.warm.add(key);
      settle(streamed);
    };
  }

  private wait(writer: Promise<boolean>, signal?: AbortSignal) {
    return new Promise<"streamed" | "failed" | "timeout">((resolve, reject) => {
      const timer = setTimeout(() => finish(() => resolve("timeout")), this.maxWaitMs);
      const onAbort = () => finish(() => reject(new Error("aborted while waiting to read cache")));
      const finish = (action: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void writer.then((streamed) => finish(() => resolve(streamed ? "streamed" : "failed")));
    });
  }
}
