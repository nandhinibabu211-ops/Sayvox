import { Agent, fetch as undiciFetch } from "undici";

/**
 * Long-lived keep-alive pool to OpenRouter (Story 3.2 AC 1). Node's default keep-alive is
 * ~4 s, so with minutes between dictations every rewrite would pay a fresh TLS handshake;
 * this keeps connections warm for 2 minutes.
 */
const agent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 300_000,
  connections: 128,
  connect: { timeout: 3_000 },
});

export const pooledFetch: typeof fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: agent,
  }) as unknown as Promise<Response>;

export function closePool(): Promise<void> {
  return agent.close();
}
