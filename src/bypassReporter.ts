/**
 * Reports enforcement-bypass windows to the platform.
 *
 * The SDK defaults to `fail_open`: when the governance plane is unreachable, or
 * the plan quota is exhausted, an action proceeds with no server enforcement
 * decision. `onEnforcementBypassed` surfaces that locally, but until it was also
 * sent to the server the platform's audit trail could not tell "all calls
 * governed" from "the SDK lost contact for two hours" — no bypass record read as
 * fully governed.
 *
 * Design: docs/superpowers/specs/2026-09-21-sdk-bypass-reporting-design.md
 *
 * - Bypasses are COALESCED into windows keyed by (agentId, reason). A per-call
 *   record would put thousands of rows a minute into a per-org hash chain.
 * - Only CLOSED windows are sent, so a window is immutable once reported. A
 *   window closes on recovery (a governed decision for the agent), after an idle
 *   gap, or at a maximum duration — a long outage is many records, not one
 *   unbounded, mutable one.
 * - Nothing here is on the enforcement path. Recording is synchronous and cheap;
 *   sending happens from a timer, and every method swallows its own errors.
 * - Evidence is kept until the server acknowledges it, retried with backoff, and
 *   the buffer is bounded. When it overflows the oldest window is dropped and the
 *   LOSS is reported too, so the trail says "N bypasses were not reported"
 *   instead of staying silent.
 */

export type BypassReason =
  | 'circuit_breaker_open'
  | 'network_error'
  | 'server_error'
  | 'plan_limit_exceeded';

/** What the SDK observed at one bypass. Timestamps are taken by the reporter. */
export interface BypassObservation {
  reason: BypassReason;
  /** The `fail_open_*` string — same vocabulary as `EnforceResult.source`. */
  source: string;
  agentId: string;
  message?: string;
  status?: number;
  consecutiveFailures?: number;
}

/** One coalesced window, exactly as the server's schema expects it. */
export interface BypassWindow {
  windowId: string;
  agentId: string;
  reason: BypassReason;
  source: string;
  /** Client clock. The server stores it as the SDK's claim. */
  firstAt: string;
  lastAt: string;
  count: number;
  status?: number;
  message?: string;
  consecutiveFailures?: number;
}

export interface DroppedBypassReports {
  dropId: string;
  windows: number;
  bypasses: number;
  since?: string;
}

export interface BypassReportBody {
  sdk: { name: string; language: 'js'; version: string };
  sentAt: string;
  windows: BypassWindow[];
  dropped?: DroppedBypassReports;
}

export interface BypassReporterOptions {
  /** Resolves with the HTTP status; rejects on a network failure. */
  send: (body: BypassReportBody) => Promise<{ status: number }>;
  sdk: { name: string; language: 'js'; version: string };
  /** No bypass for this long closes a window. Default 60 s. */
  idleMs?: number;
  /** A window never spans longer than this. Default 15 min. */
  maxDurationMs?: number;
  /** Closed windows held awaiting acknowledgement. Default 500. */
  maxBufferedWindows?: number;
  now?: () => number;
  uuid?: () => string;
  log?: (message: string) => void;
}

// Bounds mirror the server's schema (backend/src/schema/sdkBypass.ts). A field
// over its limit would get the WHOLE report rejected, so it is truncated here.
const MAX_AGENT_ID = 256;
const MAX_SOURCE = 64;
const MAX_MESSAGE = 500;
const MAX_WINDOWS_PER_REQUEST = 100;
const MAX_COUNT = 1_000_000_000;

// The server requires min length 1 for these; an empty value would get the
// whole report rejected.
const UNKNOWN = 'unknown';

// Postgres text/jsonb cannot store NUL or a lone UTF-16 surrogate. One such
// character makes the server's audit write fail, which reads as a retryable 5xx,
// so the window would be retried for ever and never recorded.
const REPLACEMENT = String.fromCharCode(0xfffd);
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Cut to `max` UTF-16 units without leaving half an emoji, then make it storable. */
function sanitize(value: string, max: number): string {
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (out.length < value.length && last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.replace(UNSTORABLE, REPLACEMENT);
}

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Statuses that mean "this body will never be accepted": resending is a loop, so
 * the batch is discarded (and logged). Everything else — 5xx, 429, 408, auth
 * errors, and 404 from a backend that does not have the endpoint yet — is kept
 * and retried: the buffer is bounded, and the evidence is worth more than a
 * request every few minutes.
 */
const NON_RETRYABLE = new Set([400, 413, 422]);

interface OpenWindow extends BypassWindow {
  firstMs: number;
  lastMs: number;
}

export class BypassWindowReporter {
  private readonly send: BypassReporterOptions['send'];
  private readonly sdk: BypassReporterOptions['sdk'];
  private readonly idleMs: number;
  private readonly maxDurationMs: number;
  private readonly maxBuffered: number;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly log: (message: string) => void;

  private open = new Map<string, OpenWindow>();
  private closed: BypassWindow[] = [];

  // Loss accounting. `pendingDrop` is the block currently awaiting acknowledgement:
  // immutable, so a retry after a lost response reuses the same dropId and the
  // server can recognise it. Drops that happen meanwhile accumulate in `liveDrop`.
  private liveDrop: { windows: number; bypasses: number; since?: string } = {
    windows: 0,
    bypasses: 0,
  };
  private pendingDrop: DroppedBypassReports | null = null;

  private inflight: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(opts: BypassReporterOptions) {
    this.send = opts.send;
    this.sdk = opts.sdk;
    this.idleMs = opts.idleMs ?? 60_000;
    this.maxDurationMs = opts.maxDurationMs ?? 15 * 60_000;
    this.maxBuffered = opts.maxBufferedWindows ?? 500;
    this.now = opts.now ?? Date.now;
    this.uuid = opts.uuid ?? (() => require('crypto').randomUUID());
    this.log = opts.log ?? (() => undefined);
  }

  /** Record one bypass. Synchronous, cheap, never throws. */
  record(obs: BypassObservation): void {
    try {
      const t = this.now();
      const agentId = sanitize(obs.agentId, MAX_AGENT_ID) || UNKNOWN;
      const source = sanitize(obs.source, MAX_SOURCE) || UNKNOWN;
      const key = `${agentId}\u0000${obs.reason}`;
      const existing = this.open.get(key);

      if (
        existing &&
        (t - existing.lastMs >= this.idleMs || t - existing.firstMs >= this.maxDurationMs)
      ) {
        this.close(key);
      }

      const w = this.open.get(key);
      if (w) {
        w.count = Math.min(w.count + 1, MAX_COUNT);
        w.lastMs = t;
        w.lastAt = new Date(t).toISOString();
        w.source = source;
        if (obs.message !== undefined) w.message = sanitize(obs.message, MAX_MESSAGE);
        if (obs.status !== undefined) w.status = obs.status;
        if (obs.consecutiveFailures !== undefined) w.consecutiveFailures = obs.consecutiveFailures;
        return;
      }

      const at = new Date(t).toISOString();
      this.open.set(key, {
        windowId: this.uuid(),
        agentId,
        reason: obs.reason,
        source,
        firstAt: at,
        lastAt: at,
        firstMs: t,
        lastMs: t,
        count: 1,
        ...(obs.status !== undefined ? { status: obs.status } : {}),
        ...(obs.message !== undefined ? { message: sanitize(obs.message, MAX_MESSAGE) } : {}),
        ...(obs.consecutiveFailures !== undefined
          ? { consecutiveFailures: obs.consecutiveFailures }
          : {}),
      });
    } catch (err) {
      this.log(`bypass record failed: ${(err as Error).message}`);
    }
  }

  /** The agent got a governed decision from the server: its windows are over. */
  recover(agentId: string): void {
    try {
      const id = sanitize(agentId, MAX_AGENT_ID) || UNKNOWN;
      for (const key of [...this.open.keys()]) {
        if (key.startsWith(`${id}\u0000`)) this.close(key);
      }
    } catch (err) {
      this.log(`bypass recover failed: ${(err as Error).message}`);
    }
  }

  /** Close windows that have gone idle. Called from the timer. */
  tick(): void {
    try {
      const t = this.now();
      for (const [key, w] of [...this.open]) {
        if (t - w.lastMs >= this.idleMs || t - w.firstMs >= this.maxDurationMs) this.close(key);
      }
    } catch (err) {
      this.log(`bypass tick failed: ${(err as Error).message}`);
    }
  }

  /** True when there is anything closed (or a loss) waiting to be acknowledged. */
  get hasPending(): boolean {
    return this.closed.length > 0 || this.pendingDrop !== null || this.liveDrop.windows > 0;
  }

  /**
   * Send everything closed until the server has acknowledged it, or a request
   * fails. `force` skips the retry backoff (shutdown). Never throws.
   */
  flush(opts: { force?: boolean } = {}): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(opts.force === true).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Shutdown: close every open window and make a bounded, best-effort attempt to
   * deliver. Gives up at the deadline rather than hanging process exit on an
   * endpoint that is down — which is exactly when there is something to report.
   */
  async drain(opts: { timeoutMs: number }): Promise<void> {
    try {
      for (const key of [...this.open.keys()]) this.close(key);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, opts.timeoutMs);
      });
      try {
        await Promise.race([this.flush({ force: true }), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      this.log(`bypass drain failed: ${(err as Error).message}`);
    }
  }

  private close(key: string): void {
    const w = this.open.get(key);
    if (!w) return;
    this.open.delete(key);

    const { firstMs: _f, lastMs: _l, ...window } = w;
    this.closed.push(window);

    // Bounded: never let an outage grow memory without limit. The oldest goes
    // first, and the loss is counted so it can be reported.
    while (this.closed.length > this.maxBuffered) {
      const dropped = this.closed.shift()!;
      this.liveDrop.windows += 1;
      this.liveDrop.bypasses += dropped.count;
      if (this.liveDrop.since === undefined) this.liveDrop.since = dropped.firstAt;
    }
  }

  private async run(force: boolean): Promise<void> {
    try {
      while (this.hasPending) {
        if (!force && this.now() < this.nextAttemptAt) return;

        if (!this.pendingDrop && this.liveDrop.windows > 0) {
          this.pendingDrop = { dropId: this.uuid(), ...this.liveDrop };
          this.liveDrop = { windows: 0, bypasses: 0 };
        }

        const windows = this.closed.slice(0, MAX_WINDOWS_PER_REQUEST);
        const body: BypassReportBody = {
          sdk: this.sdk,
          sentAt: new Date(this.now()).toISOString(),
          windows,
          ...(this.pendingDrop ? { dropped: this.pendingDrop } : {}),
        };

        let status: number;
        try {
          status = (await this.send(body)).status;
        } catch (err) {
          this.fail(`bypass report failed: ${(err as Error).message}`);
          return;
        }

        if (status >= 200 && status < 300) {
          this.failures = 0;
          this.nextAttemptAt = 0;
          this.acknowledge(windows);
        } else if (NON_RETRYABLE.has(status)) {
          // The body will never be accepted; resending is a loop.
          this.log(
            `bypass report rejected (HTTP ${status}); discarding ${windows.length} window(s)`,
          );
          this.acknowledge(windows);
        } else {
          this.fail(`bypass report failed (HTTP ${status})`);
          return;
        }
      }
    } catch (err) {
      this.fail(`bypass report failed: ${(err as Error).message}`);
    }
  }

  private acknowledge(sent: BypassWindow[]): void {
    const ids = new Set(sent.map((w) => w.windowId));
    this.closed = this.closed.filter((w) => !ids.has(w.windowId));
    this.pendingDrop = null;
  }

  private fail(message: string): void {
    this.failures += 1;
    this.nextAttemptAt =
      this.now() + Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.log(message);
  }
}
