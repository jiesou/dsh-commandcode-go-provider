/**
 * dsh-commandcode-go-provider — Command Code Go provider for the dsh harness.
 *
 * A Go-plan subscription has no Provider-API access: the OpenAI-compatible
 * endpoints (`/provider/v1/chat/completions`) answer 403 `upgrade_required`,
 * so every request must go through Command Code's private CLI gateway at
 * `/alpha/generate`. This plugin:
 *
 * 1. Scans the public model catalog (`/provider/v1/models`, open endpoint) and
 *    keeps the models the Go plan includes (open-source plus GPT-5.6 Luna,
 *    Grok 4.5, Muse Spark 1.2 Contributor), re-scanning on an interval. The
 *    Provider API discloses no reasoning metadata, so per-model effort support
 *    is merged from the official `command-code` CLI catalog
 *    (`reference/models.md`, fetched live from jsDelivr).
 * 2. Registers one configurable provider route per configured account (the
 *    `accounts` dictionary; a single default account when it is absent) whose
 *    adapter streams over `/alpha/generate`, so the harness model picker,
 *    tools, and reasoning-effort controls all work against the Go catalog —
 *    once per account, sharing one scanned catalog.
 * 3. Resolves each account's bearer key per request through the credential
 *    seam (default `COMMANDCODE_API_KEY`), failing loud when it is missing.
 *
 * @module dsh-commandcode-go-provider
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js';
export { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, } from './adapter.js';
export type { CommandCodeGoAdapterOptions, CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js';
export { fetchCatalog, fetchGoModels, imageCapable, isGoPlan, parseCatalog } from './models.js';
export type { CatalogEntry, GoModel } from './models.js';
export declare const name = "commandcode-go-provider";
export declare const inject: string[];
/**
 * One account's overrides. Every field defaults to the top-level field of the
 * same name, so the top-level config doubles as the shared default.
 */
export interface AccountProfile {
    /** Picker/directory label; defaults to the account key. */
    displayName?: string;
    /** Credential reference resolved per request; defaults to the top-level `apiKeyEnv`. */
    apiKeyEnv?: string;
    /** Gateway base URL; defaults to the top-level `baseURL`. */
    baseURL?: string;
    /** Default per-request output cap; defaults to the top-level `maxTokens`. */
    maxTokens?: number;
    /** Positive context capacity used when the selected model has no exact value; defaults to the top-level value. */
    defaultContextWindow?: number;
    /** Provider-owned model-request retry policy; defaults to the top-level `retryPolicy`. */
    retryPolicy?: RetryPolicyConfig;
}
/**
 * Plugin configuration, validated by the same-named schemastery schema and
 * doubling as the `dsh-commandcode-go-provider` settings-section shape.
 */
export interface Config {
    /** Named accounts; each key becomes an independent provider route. Absent or empty = one account from the top-level fields. */
    accounts?: Record<string, AccountProfile>;
    /** Credential reference resolved per request; defaults to `COMMANDCODE_API_KEY`. Also every account's default. */
    apiKeyEnv?: string;
    /** Gateway base URL; defaults to `https://api.commandcode.ai`. Also every account's default. */
    baseURL?: string;
    /** Default per-request output cap (default 64,000); explicit request values win. Also every account's default. */
    maxTokens?: number;
    /** Positive context capacity used when the selected model has no exact value (default 1,000,000). Also every account's default. */
    defaultContextWindow?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. Also every account's default. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const AccountProfile: z<AccountProfile>;
export declare const Config: z<Config>;
/** Resolved connection facts per provider route, keyed by route id. */
export type ResolvedAccounts = Map<string, CommandCodeGoConnectionOptions>;
/**
 * The one explicit resolve step from raw config to per-route connection
 * facts. An absent or empty `accounts` dictionary means one synthetic default
 * account on the top-level fields; otherwise every key is a route and the
 * top-level fields are each account's shared defaults. Bounds are the
 * schema's job, so this only maps.
 */
export declare function resolveAccounts(config: Config, scanned: readonly CommandCodeGoModel[]): ResolvedAccounts;
export declare function apply(ctx: Context, config: Config): void;
