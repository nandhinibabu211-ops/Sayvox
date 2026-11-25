import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Canonical model: specs/001-voice-to-prompt-mvp/data-model.md.
 * Privacy rule (Constitution I): no table stores transcript, partial, rewrite or thread text.
 * test/unit/schema-privacy.test.ts fails the build if such a column appears.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const userStatus = pgEnum("user_status", ["active", "suspended", "deleted"]);
export const presetEnum = pgEnum("preset", ["fastest", "balanced", "cheapest"]);
export const modeEnum = pgEnum("mode", ["dictation", "prompt", "email"]);
export const insertModeEnum = pgEnum("insert_mode", ["auto", "review"]);
export const sessionStatus = pgEnum("session_status", [
  "started",
  "completed",
  "raw_fallback",
  "failed",
  "abandoned",
]);
export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "past_due",
  "cancelled",
  "incomplete",
]);

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  monthlyAudioMinutes: integer("monthly_audio_minutes").notNull(),
  dailyCapMinutes: integer("daily_cap_minutes").notNull(),
  allowedPresets: presetEnum("allowed_presets").array().notNull(),
  dictionaryLimit: integer("dictionary_limit").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  authProviderId: text("auth_provider_id").notNull().unique(),
  planId: text("plan_id")
    .notNull()
    .default("free")
    .references(() => plans.id),
  status: userStatus("status").notNull().default("active"),
  region: text("region"),
  consentedAt: ts("consented_at"),
  termsVersion: text("terms_version"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("razorpay"),
    providerSubId: text("provider_sub_id").notNull().unique(),
    status: subscriptionStatus("status").notNull(),
    currentPeriodEnd: ts("current_period_end"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.providerSubId] })],
);

export const settings = pgTable(
  "settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    preset: presetEnum("preset").notNull().default("balanced"),
    defaultMode: modeEnum("default_mode").notNull().default("dictation"),
    appModeOverrides: jsonb("app_mode_overrides")
      .$type<Record<string, "dictation" | "prompt" | "email">>()
      .notNull()
      .default({}),
    insertMode: insertModeEnum("insert_mode").notNull().default("auto"),
    languageHint: text("language_hint"),
    hotkey: text("hotkey").notNull().default("Ctrl+Shift"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  // The ≤ 100 overrides cap is enforced by the shared Zod `Settings` schema (Postgres CHECK
  // constraints can't count jsonb keys without a subquery).
  (t) => [
    check("settings_overrides_is_object", sql`jsonb_typeof(${t.appModeOverrides}) = 'object'`),
  ],
);

export const dictionaryTerms = pgTable(
  "dictionary_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("dictionary_terms_user_idx").on(t.userId),
    uniqueIndex("dictionary_terms_user_term_uq").on(t.userId, sql`lower(${t.term})`),
    check("dictionary_terms_len", sql`char_length(${t.term}) BETWEEN 1 AND 64`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    mode: modeEnum("mode"),
    targetApp: text("target_app"),
    audioSeconds: numeric("audio_seconds", { precision: 8, scale: 2 }),
    modelUsed: text("model_used"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    ttftMs: integer("ttft_ms"),
    totalMs: integer("total_ms"),
    sttCommitMs: integer("stt_commit_ms"),
    releaseToInsertMs: integer("release_to_insert_ms"),
    status: sessionStatus("status").notNull().default("started"),
    clientVersion: text("client_version"),
    region: text("region"),
  },
  (t) => [
    index("sessions_user_started_idx").on(t.userId, t.startedAt.desc()),
    index("sessions_started_sweep_idx")
      .on(t.startedAt)
      .where(sql`${t.status} = 'started'`),
  ],
);

export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    audioSeconds: numeric("audio_seconds", { precision: 10, scale: 2 }).notNull().default("0"),
    requests: integer("requests").notNull().default(0),
    llmCostUsd: numeric("llm_cost_usd", { precision: 10, scale: 5 }).notNull().default("0"),
    sttCostUsd: numeric("stt_cost_usd", { precision: 10, scale: 5 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export const billingEvents = pgTable(
  "billing_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

export const schema = {
  plans,
  users,
  subscriptions,
  settings,
  dictionaryTerms,
  sessions,
  usageDaily,
  billingEvents,
};
