import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";
import { keys } from "../../lib/redis/keys";

/**
 * One-time stream tickets (audit SEC-03). /v1/session/start mints the ElevenLabs single-use
 * token but keeps it: the client only gets a random ticket, which /v1/stream exchanges
 * (exactly once) for the token and the session it belongs to.
 */
export const StreamTicketData = z.object({
  sessionId: z.uuid(),
  userId: z.string().min(1),
  scribeToken: z.string().min(1),
  keyterms: z.array(z.string()),
  languageHint: z.string().nullable(),
  keytermsUsed: z.boolean(),
  maxSessionSeconds: z.number().positive(),
});
export type StreamTicketData = z.infer<typeof StreamTicketData>;

const TICKET = /^[A-Za-z0-9_-]{43}$/;

export async function issueTicket(
  redis: Redis,
  data: StreamTicketData,
  ttlSeconds: number,
): Promise<string> {
  const ticket = randomBytes(32).toString("base64url"); // 43 chars
  await redis.set(keys.streamTicket(ticket), JSON.stringify(data), "EX", Math.ceil(ttlSeconds));
  return ticket;
}

/** Returns the ticket's data and deletes it, or null (unknown, expired, used, malformed). */
export async function takeTicket(redis: Redis, ticket: string): Promise<StreamTicketData | null> {
  if (!TICKET.test(ticket)) return null;
  const raw = await redis.getdel(keys.streamTicket(ticket));
  if (!raw) return null;
  try {
    return StreamTicketData.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
