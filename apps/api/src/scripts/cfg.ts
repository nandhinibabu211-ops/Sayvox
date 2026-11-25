/* eslint-disable no-console -- CLI script */
/**
 * Change client config at runtime without a deploy (Story 2.9, runbooks):
 *
 *   pnpm --filter @sayvox/api cfg:get
 *   pnpm --filter @sayvox/api cfg:set rolloutPercent=10
 *   pnpm --filter @sayvox/api cfg:set killSwitch=true "killSwitchMessage=Back in 10 minutes"
 *   pnpm --filter @sayvox/api cfg:set minClientVersion=0.2.0
 *   pnpm --filter @sayvox/api cfg:unset killSwitch
 *
 * Writes the `cfg:client` override in Redis (REDIS_URL); API instances pick it up within
 * 10 s. Each change is printed as one JSON line for the audit log.
 */
import { Redis } from "ioredis";
import { keys } from "../lib/redis/keys";
import { applyCfgArgs, ClientOverride } from "../modules/config/override";

const [command = "", ...args] = process.argv.slice(2);
const url = process.env["REDIS_URL"];
if (!url) {
  console.error("REDIS_URL is not set");
  process.exit(1);
}

const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
try {
  await redis.connect();
  const raw = await redis.get(keys.clientConfig());
  const current = ClientOverride.parse(raw ? JSON.parse(raw) : {});
  if (command === "get") {
    console.log(JSON.stringify(current, null, 2));
  } else if (command === "set" || command === "unset") {
    const next = applyCfgArgs(current, command, args);
    await redis.set(keys.clientConfig(), JSON.stringify(next));
    console.log(
      JSON.stringify({
        audit: "client-config-change",
        at: new Date().toISOString(),
        by: process.env["USER"] ?? process.env["USERNAME"] ?? "unknown",
        before: current,
        after: next,
      }),
    );
  } else {
    console.error("usage: cfg.ts <get|set key=value…|unset key…>");
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
