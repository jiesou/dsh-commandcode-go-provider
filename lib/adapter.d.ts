/**
 * Command Code Go adapter: a harness `LlmAdapter` whose stream transport is
 * Command Code's private `/alpha/generate` gateway, which is the only
 * endpoint a Go-plan subscription can call (the OpenAI-compatible Provider
 * API answers 403 for Go).
 *
 * The adapter is transport-only: per-account connection facts (display name,
 * base URL, key reference) arrive through a route-aware thunk resolved once
 * per operation and the bearer key through a per-route resolver, so the
 * registering plugin owns validation, layering, and credential policy. Model
 * metadata — the scanned Go catalog, shared by every account — flows through
 * `listModels()` / `resolveModel()`.
 *
 * @module dsh-commandcode-go-provider/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, ImageAttachmentAccess, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { DEFAULT_MAX_TOKENS } from './protocol.js';
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
    /** Whether the model accepts image input; absent means unknown (no modality is declared). */
    imageInput?: boolean;
}
/** Validated connection facts for one account (one provider route). */
export interface CommandCodeGoConnectionOptions {
    /** Picker/directory label for this account. */
    displayName: string;
    /** Credential reference resolved per request. */
    apiKeyEnv: CredentialRef;
    /** Gateway base URL; `/alpha/generate` is appended. */
    baseURL: string;
    /** Default per-request output cap. */
    maxTokens: number;
    /** Positive context capacity used when the selected model has no exact value. */
    defaultContextWindow: number;
    /** Inline base64 image bytes one request accepts before it must be offloaded. */
    maxRequestImageBytes: number;
    /** Scanned Go catalog; requests remain unrestricted. */
    models: readonly CommandCodeGoModel[];
    /** Provider-owned model-request retry policy, already resolved. */
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options for {@link CommandCodeGoAdapter}. */
export interface CommandCodeGoAdapterOptions {
    /** Current validated connection facts for one account; called once per operation. */
    account: (provider: string) => CommandCodeGoConnectionOptions;
    /** Resolve the bearer token for one account; throws `MISSING_CREDENTIAL` when unavailable. */
    resolveApiKey: (provider: string) => Promise<string>;
    /**
     * The durable attachment service, resolved lazily so a deployment without
     * one keeps working for text-only traffic.
     */
    resolveAttachments?: () => AttachmentStore | undefined;
    /**
     * Map one durable image's stored host object into the current tool execution
     * world, so an offloaded occurrence still names a path the model can read.
     */
    resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined;
}
/** Default maximum idle interval while an adapter stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default combined request/response context capacity. */
export declare const DEFAULT_CONTEXT_WINDOW = 1000000;
/**
 * Default inline image budget for one request, deliberately below the official
 * pi-ai adapter's 20 MiB: the gateway stream is stateless, so every retained
 * image rides every turn again, and a smaller budget keeps a long conversation
 * from re-sending megabytes of images on each request.
 */
export declare const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 4194304;
export { DEFAULT_MAX_TOKENS };
/**
 * Command Code Go adapter. One instance serves every configured account; the
 * harness model id IS the gateway wire model id.
 */
export declare class CommandCodeGoAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: CommandCodeGoAdapterOptions);
    /**
     * Resolve the request bytes for every retained image in the conversation. The
     * attachment service is optional: a deployment without one keeps serving
     * text-only traffic and fails loud only when an image actually arrives.
     *
     * A request that exceeds the route's image budget fails with
     * `IMAGE_OFFLOAD_REQUIRED` naming how many oldest occurrences must be
     * offloaded; the harness logs that selection and retries, so no image is ever
     * dropped without a durable decision.
     */
    private prepareRequestImages;
    /**
     * The one projection every request shares: an offloaded occurrence reaches
     * the gateway as placeholder text instead of bytes, and only retained
     * occurrences are resolved, encoded, and sent.
     */
    private requestMessages;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private request;
}
