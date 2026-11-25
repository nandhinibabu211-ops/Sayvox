import { ClientConfig, Preset } from "@sayvox/shared";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Env } from "../../config/env";
import { getJson } from "../../lib/redis/client";
import { keys } from "../../lib/redis/keys";
import { compareVersions, rolloutBucket } from "./semver";

import { ClientOverride } from "./override";

const PresetOverride = z.partialRecord(Preset, z.array(z.string().min(1)).min(1));

export type PresetModels = Record<Preset, string[]>;

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Config-driven behaviour (Constitution VII): presets, model slugs, kill switch, minimum
 * client version and rollout. Env gives defaults; Redis `cfg:*` keys override at runtime.
 * Redis reads are cached in memory for `cacheMs` and fall back to env if Redis is down.
 */
export class ConfigService {
  private clientCache: Cached<z.infer<typeof ClientOverride>> | undefined;
  private presetCache: Cached<z.infer<typeof PresetOverride>> | undefined;

  constructor(
    private readonly env: Env,
    private readonly redis: Redis | undefined,
    private readonly cacheMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async readOverride<T>(
    key: string,
    schema: z.ZodType<T>,
    cache: Cached<T> | undefined,
    store: (c: Cached<T>) => void,
  ): Promise<T> {
    if (cache && this.now() - cache.at < this.cacheMs) return cache.value;
    let value = {} as T;
    if (this.redis) {
      try {
        const parsed = schema.safeParse(await getJson(this.redis, key));
        if (parsed.success) value = parsed.data;
      } catch {
        // Redis unavailable: keep env defaults rather than failing the request.
        if (cache) return cache.value;
      }
    }
    store({ value, at: this.now() });
    return value;
  }

  async presets(): Promise<PresetModels> {
    const o = await this.readOverride(keys.presets(), PresetOverride, this.presetCache, (c) => {
      this.presetCache = c;
    });
    return {
      fastest: o.fastest ?? this.env.PRESET_FASTEST,
      balanced: o.balanced ?? this.env.PRESET_BALANCED,
      cheapest: o.cheapest ?? this.env.PRESET_CHEAPEST,
    };
  }

  /** Lowest allowed reasoning effort for one model slug (sent per attempt, research R2). */
  reasoningEffort(slug: string): "none" | "minimal" | "low" | "medium" | "high" {
    return this.env.MODEL_REASONING_EFFORT[slug] ?? "none";
  }

  async clientConfig(installId?: string): Promise<ClientConfig> {
    const o = await this.readOverride(
      keys.clientConfig(),
      ClientOverride,
      this.clientCache,
      (c) => {
        this.clientCache = c;
      },
    );
    const rolloutPercent = o.rolloutPercent ?? this.env.ROLLOUT_PERCENT;
    return ClientConfig.parse({
      minClientVersion: o.minClientVersion ?? this.env.MIN_CLIENT_VERSION,
      latestClientVersion: o.latestClientVersion ?? this.env.LATEST_CLIENT_VERSION,
      killSwitch: o.killSwitch ?? this.env.KILL_SWITCH,
      killSwitchMessage: o.killSwitchMessage ?? this.env.KILL_SWITCH_MESSAGE,
      rolloutPercent,
      inRollout: installId ? rolloutBucket(installId) < rolloutPercent : rolloutPercent === 100,
    });
  }

  /** True when this client must update before using the service. */
  async isOutdated(clientVersion: string): Promise<boolean> {
    const cfg = await this.clientConfig();
    return compareVersions(clientVersion, cfg.minClientVersion) < 0;
  }
}
