import { z } from "zod";

const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "use major.minor.patch");

/** Runtime overrides an operator can set in Redis `cfg:client` (all fields optional). */
export const ClientOverride = z
  .object({
    minClientVersion: Version,
    latestClientVersion: Version,
    killSwitch: z.boolean(),
    killSwitchMessage: z.string().min(1).max(200),
    rolloutPercent: z.int().min(0).max(100),
  })
  .partial()
  .strict();
export type ClientOverride = z.infer<typeof ClientOverride>;

const KEYS = Object.keys(ClientOverride.shape) as (keyof ClientOverride)[];

function coerce(key: keyof ClientOverride, raw: string): unknown {
  if (key === "killSwitch") {
    if (raw === "true" || raw === "false") return raw === "true";
    throw new Error("killSwitch must be true or false");
  }
  if (key === "rolloutPercent") return Number(raw);
  return raw;
}

/** `set a=1 b=2` / `unset a b` → the new override, validated. Throws with a clear message. */
export function applyCfgArgs(
  current: ClientOverride,
  command: "set" | "unset",
  args: string[],
): ClientOverride {
  const next: Record<string, unknown> = { ...current };
  if (args.length === 0) throw new Error(`nothing to ${command}`);
  for (const arg of args) {
    const i = arg.indexOf("=");
    const key = (command === "set" ? arg.slice(0, i) : arg) as keyof ClientOverride;
    if (!KEYS.includes(key)) throw new Error(`unknown key "${key}" (known: ${KEYS.join(", ")})`);
    if (command === "unset") delete next[key];
    else {
      if (i < 1) throw new Error(`expected key=value, got "${arg}"`);
      next[key] = coerce(key, arg.slice(i + 1));
    }
  }
  const parsed = ClientOverride.safeParse(next);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
  }
  return parsed.data;
}
