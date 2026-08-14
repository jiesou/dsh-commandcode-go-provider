/**
 * commandcode-go — Command Code Go provider for the dsh harness.
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
 * 2. Registers a `commandcode` provider route on `ctx.llm` whose adapter
 *    streams over `/alpha/generate`, so the harness model picker, tools, and
 *    reasoning-effort controls all work against the Go catalog.
 * 3. Resolves the bearer key per request through the credential seam
 *    (default `COMMANDCODE_API_KEY`), failing loud when it is missing.
 *
 * @module commandcode-go
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js';
export { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, } from './adapter.js';
export type { CommandCodeGoAdapterOptions, CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js';
export { fetchCatalogEfforts, fetchGoModels, isGoModel, parseCatalogEfforts } from './models.js';
export declare const name = "commandcode-go";
export declare const inject: string[];
/**
 * Plugin configuration, validated by the same-named schemastery schema and
 * doubling as the `commandcode-go` settings-section shape.
 */
export interface Config {
    /** Credential reference resolved per request; defaults to `COMMANDCODE_API_KEY`. */
    apiKeyEnv?: string;
    /** Gateway base URL; defaults to `https://api.commandcode.ai`. */
    baseURL?: string;
    /** Default reasoning effort when the caller names none; the model's catalog effort set decides. */
    reasoningEffort?: 'off' | 'high' | 'max';
    /** Default per-request output cap (default 64,000); explicit request values win. */
    maxTokens?: number;
    /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
    defaultContextWindow?: number;
    /** Advisory models; the live scan replaces this when it succeeds. */
    models?: CommandCodeGoModel[];
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Config>;
/** The one explicit resolve step from raw config to validated connection facts. */
export declare function resolveAdapterOptions(config: Config): CommandCodeGoConnectionOptions;
export declare function apply(ctx: Context, config: Config): void;
