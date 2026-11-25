import { ErrorEnvelope } from "@sayvox/shared";
import {
  SessionExpiredError,
  type RefreshFn,
  type SessionStore,
  type StoredSession,
} from "./session";

export interface ApiClientOptions {
  baseUrl: string;
  store: SessionStore;
  /** Builds a refresher for the signed-in user (needs their email for the stored session). */
  makeRefresher: (email: string) => RefreshFn;
  clientVersion: string;
  installId: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Refresh this long before expiry to avoid sending a token that expires in flight. */
  refreshSkewMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Calls the Sayvox API with the user's Identity Platform ID token (Story 2.2 AC 5):
 * refreshes ahead of expiry, refreshes once on 401 and retries the request once.
 * Concurrent callers share a single in-flight refresh.
 */
export class ApiClient {
  private refreshing: Promise<StoredSession> | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly skew: number;

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.skew = opts.refreshSkewMs ?? 60_000;
  }

  private refresh(session: StoredSession): Promise<StoredSession> {
    if (!this.refreshing) {
      this.refreshing = this.opts
        .makeRefresher(session.email)(session.refreshToken)
        .then(async (next) => {
          await this.opts.store.save(next);
          return next;
        })
        .catch(async (err: unknown) => {
          if (err instanceof SessionExpiredError) await this.opts.store.clear();
          throw err;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    return this.refreshing;
  }

  private async token(): Promise<string> {
    if (this.refreshing) return (await this.refreshing).idToken;
    const session = await this.opts.store.load();
    if (!session) throw new SessionExpiredError();
    if (session.expiresAt - this.skew > this.now()) return session.idToken;
    return (await this.refresh(session)).idToken;
  }

  private send(path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-client-version", this.opts.clientVersion);
    headers.set("x-install-id", this.opts.installId);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return this.fetchFn(`${this.opts.baseUrl}${path}`, { ...init, headers });
  }

  /** Raw response (used for SSE). Throws ApiError for non-2xx. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    let res = await this.send(path, init, await this.token());
    if (res.status === 401) {
      const session = await this.opts.store.load();
      if (!session) throw new SessionExpiredError();
      res = await this.send(path, init, (await this.refresh(session)).idToken);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const parsed = ErrorEnvelope.safeParse(await res.json());
    if (parsed.success) {
      const e = parsed.data.error;
      return new ApiError(res.status, e.code, e.message, e.requestId);
    }
  } catch {
    // Non-JSON error body.
  }
  return new ApiError(res.status, "INTERNAL", `HTTP ${res.status}`);
}
