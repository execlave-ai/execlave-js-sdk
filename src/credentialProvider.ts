/**
 * Workload identity federation: turns identity provider tokens into the
 * short-lived `exe_agt_` API credential the SDK authenticates with.
 */

import { ExeclaveAuthError, ExeclaveError } from './errors';

/** The exchange endpoint's answer (`data` of `POST /agent-credentials/exchange`). */
export interface ExchangedCredential {
  /** `exe_agt_` API credential, sent as `Authorization: Bearer`. */
  credential: string;
  /** ISO 8601 expiry of the credential. */
  expiresAt: string;
  /** Internal UUID of the agent the credential acts for. */
  agentId: string;
}

export interface FederatedCredentialSourceOptions {
  /** Returns a fresh identity provider token (the user's `credentialProvider`). */
  provider: () => string | Promise<string>;
  /** Exchanges an identity provider token for an Execlave credential. */
  exchange: (idpToken: string) => Promise<ExchangedCredential>;
  /** Exchange again when the cached credential has less than this left. Default 60 s. */
  refreshBeforeMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

const DEFAULT_REFRESH_BEFORE_MS = 60_000;

/**
 * Caches the exchanged credential and exchanges again shortly before it
 * expires. Concurrent callers share one exchange, so a burst of calls at
 * startup or at expiry costs one identity provider token and one exchange.
 *
 * A failed refresh is not hidden: callers get the error, and the next call
 * tries again. The source never falls back to a credential that is about to
 * expire, because the server would refuse it a moment later anyway.
 */
export class FederatedCredentialSource {
  private readonly _provider: FederatedCredentialSourceOptions['provider'];
  private readonly _exchange: FederatedCredentialSourceOptions['exchange'];
  private readonly _refreshBeforeMs: number;
  private readonly _now: () => number;

  private _current: { value: ExchangedCredential; expiresAtMs: number } | null = null;
  private _inFlight: Promise<ExchangedCredential> | null = null;
  private _boundAgentId: string | null = null;

  constructor(opts: FederatedCredentialSourceOptions) {
    this._provider = opts.provider;
    this._exchange = opts.exchange;
    this._refreshBeforeMs = opts.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
    this._now = opts.now ?? Date.now;
  }

  /** UUID of the agent the credentials act for, once the first exchange succeeded. */
  get boundAgentId(): string | null {
    return this._boundAgentId;
  }

  /** A credential with more than `refreshBeforeMs` left, exchanging a new one if needed. */
  async get(): Promise<ExchangedCredential> {
    if (this._current && this._current.expiresAtMs - this._now() > this._refreshBeforeMs) {
      return this._current.value;
    }
    if (!this._inFlight) {
      this._inFlight = this._refresh().finally(() => {
        this._inFlight = null;
      });
    }
    return this._inFlight;
  }

  private async _refresh(): Promise<ExchangedCredential> {
    const idpToken = await this._provider();
    if (typeof idpToken !== 'string' || idpToken.length === 0) {
      throw new ExeclaveError('credentialProvider returned no token');
    }

    const exchanged = await this._exchange(idpToken);
    const expiresAtMs = Date.parse(exchanged?.expiresAt ?? '');
    if (
      typeof exchanged?.credential !== 'string' ||
      !exchanged.credential.startsWith('exe_agt_') ||
      typeof exchanged.agentId !== 'string' ||
      !exchanged.agentId ||
      Number.isNaN(expiresAtMs)
    ) {
      throw new ExeclaveError('Credential exchange returned an unexpected response');
    }

    // Everything the SDK has registered locally points at the first agent. If
    // the identity provider subject is now bound to a different agent, carrying
    // on would send that agent's credential with the old agent's ID, so stop.
    if (this._boundAgentId && exchanged.agentId !== this._boundAgentId) {
      throw new ExeclaveAuthError(
        `Federated identity is now bound to agent ${exchanged.agentId}, not ${this._boundAgentId}; create a new Execlave client`,
      );
    }
    this._boundAgentId = exchanged.agentId;
    this._current = { value: exchanged, expiresAtMs };
    return exchanged;
  }
}
