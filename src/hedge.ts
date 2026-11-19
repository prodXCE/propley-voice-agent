/**
 * Hedged requests: start the primary; if it has produced nothing by `hedgeMs`, start the backup too, and keep
 * whichever produces a first item first (the other is closed). A candidate that fails or ends empty before its
 * first item starts the backup at once. Nothing at all by `deadlineMs` is an error, so a turn can never hang.
 * No LiveKit types here, so it can be tested with plain async iterators.
 */
export interface Candidate<T> {
  label: string;
  iterator: AsyncIterator<T>;
  close(): void;
}

export interface HedgeResult<T> {
  winner: Candidate<T>;
  /** The winner's first item; undefined when every candidate ended empty (the winner is then the last). */
  first: T | undefined;
  hedged: boolean;
  /** Labels of the candidates that failed (errored, not just ended empty) before the winner answered. */
  failed: string[];
}

type Outcome<T> =
  | { kind: "item"; c: Candidate<T>; value: T }
  | { kind: "empty"; c: Candidate<T> }
  | { kind: "failed"; c: Candidate<T>; error: unknown }
  | { kind: "hedge" }
  | { kind: "deadline" }
  | { kind: "aborted" };

export class HedgeError extends Error {}

export async function raceFirst<T>(
  startPrimary: () => Candidate<T>,
  startBackup: (() => Candidate<T>) | null,
  { hedgeMs, deadlineMs, signal }: { hedgeMs: number; deadlineMs: number; signal?: AbortSignal },
): Promise<HedgeResult<T>> {
  const started = Date.now();
  const live = new Map<Candidate<T>, Promise<Outcome<T>>>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let hedged = false;
  let lastEmpty: Candidate<T> | null = null;
  const failed: string[] = [];

  const watch = (c: Candidate<T>) =>
    live.set(
      c,
      c.iterator.next().then(
        (r): Outcome<T> => (r.done ? { kind: "empty", c } : { kind: "item", c, value: r.value }),
        (error): Outcome<T> => ({ kind: "failed", c, error }),
      ),
    );
  const after = (ms: number, outcome: Outcome<T>) =>
    new Promise<Outcome<T>>((resolve) => timers.push(setTimeout(() => resolve(outcome), Math.max(0, ms))));
  const startBackupNow = () => {
    if (hedged || !startBackup) return false;
    hedged = true;
    watch(startBackup());
    return true;
  };
  const closeAll = () => {
    for (const c of live.keys()) c.close();
  };

  const aborted = new Promise<Outcome<T>>((resolve) => {
    if (signal?.aborted) resolve({ kind: "aborted" });
    signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
  });

  watch(startPrimary());
  try {
    for (;;) {
      if (live.size === 0) {
        if (startBackupNow()) continue;
        if (lastEmpty) return { winner: lastEmpty, first: undefined, hedged, failed };
        throw new HedgeError(`no answer from ${hedged ? "either region" : "the model"}`);
      }
      const elapsed = Date.now() - started;
      const outcome = await Promise.race([
        ...live.values(),
        after(deadlineMs - elapsed, { kind: "deadline" }),
        ...(!hedged && startBackup ? [after(hedgeMs - elapsed, { kind: "hedge" })] : []),
        aborted,
      ]);
      switch (outcome.kind) {
        case "item":
          live.delete(outcome.c);
          closeAll(); // the losers
          return { winner: outcome.c, first: outcome.value, hedged, failed };
        case "empty":
        case "failed":
          live.delete(outcome.c);
          if (outcome.kind === "empty") lastEmpty = outcome.c;
          else failed.push(outcome.c.label);
          startBackupNow();
          break;
        case "hedge":
          startBackupNow();
          break;
        case "deadline":
          closeAll();
          throw new HedgeError(`no first token within ${deadlineMs} ms`);
        case "aborted":
          closeAll();
          throw new HedgeError("aborted");
      }
    }
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}
