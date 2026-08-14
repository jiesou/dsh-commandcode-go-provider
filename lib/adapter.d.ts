/**
 * Command Code Go adapter: a harness `LlmAdapter` whose stream transport is
 * Command Code's private `/alpha/generate` gateway, which is the only
 * endpoint a Go-plan subscription can call (the OpenAI-compatible Provider
 * API answers 403 for Go).
 *
 * The adapter is transport-only: connection facts (base URL, catalog,
 * reasoning defaults) arrive through a thunk resolved once per operation and
 * the bearer key through a per-request resolver, so the registering plugin
 * owns validation, layering, and credential policy. Model metadata — the
 * scanned Go catalog — flows through `listModels()` / `resolveModel()`.
 *
 * @module commandcode-go/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { newThreadId } from './protocol.js';
/** One catalog model advertised by the adapter. */
export interface CommandCodeGoModel {
    /** Wire model id accepted by the gateway. */
    id: string;
    /** Selector label; defaults to {@link id}. */
    name?: string;
    /** Known combined request/response context capacity, when disclosed. */
    contextWindow?: number;
    /** Per-request output cap. */
    maxTokens?: number;
    /** Reasoning-effort ids the gateway accepts for this model, in display order. */
    efforts?: string[];
}
/** Validated connection facts for one operation. */
export interface CommandCodeGoConnectionOptions {
    /** Credential reference resolved per request. */
    apiKeyEnv: CredentialRef;
    /** Gateway base URL; `/alpha/generate` is appended. */
    baseURL: string;
    /** Adapter-level reasoning effort default, when configured. */
    reasoningEffort?: string;
    /** Default per-request output cap. */
    maxTokens: number;
    /** Positive context capacity used when the selected model has no exact value. */
    defaultContextWindow: number;
    /** Advisory models; requests remain unrestricted. */
    models: readonly CommandCodeGoModel[];
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs: number;
    /** Provider-owned model-request retry policy, already resolved. */
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options for {@link CommandCodeGoAdapter}. */
export interface CommandCodeGoAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => CommandCodeGoConnectionOptions;
    /** Resolve the bearer token for one request; throws `MISSING_CREDENTIAL` when unavailable. */
    resolveApiKey: () => Promise<string>;
}
/** Default maximum idle interval while an adapter stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default combined request/response context capacity. */
export declare const DEFAULT_CONTEXT_WINDOW = 1000000;
/** Default per-request output-token cap. */
export declare const DEFAULT_MAX_TOKENS = 64000;
/**
 * Command Code Go adapter. One instance serves every model in the scanned Go
 * catalog; the harness model id IS the gateway wire model id.
 */
export declare class CommandCodeGoAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: CommandCodeGoAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private request;
}
export { newThreadId };
