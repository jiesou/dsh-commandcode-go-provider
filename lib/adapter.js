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
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, errorChain, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { buildRequest, CC_VERSION, collectRequestImages, DEFAULT_MAX_TOKENS, eventToChunks, GATEWAY_EFFORTS, gatewayErrorDetail, parseEventStream, streamErrorDetail, } from './protocol.js';
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export { DEFAULT_MAX_TOKENS };
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
/**
 * Per-image request budget, matching the official pi-ai adapter's defaults:
 * the full 2048px normalized attachment, re-encoded to fit 1MiB per image.
 */
const REQUEST_IMAGE_POLICY = { maxPixels: 4_194_304, maxBytes: 1_048_576 };
function effortInfo(effort) {
    return { id: ReasoningEffortId(effort), name: GATEWAY_EFFORTS[effort] ?? effort };
}
function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        // An explicit omission is negative capability; an unknown model declares
        // nothing rather than guessing the endpoint (the two wrong answers do not
        // cost the same: over-claiming leaves a durable message no request can
        // replay, under-claiming refuses the image while it is still cheap).
        ...model.imageInput === undefined ? {} : { inputModalities: model.imageInput ? ['text', 'image'] : ['text'] },
    };
}
/**
 * Build the reasoning-effort selector for one model, or nothing at all.
 *
 * The gateway has no wire value that turns thinking off, so `Off` is offered
 * as an explicit "do not send `reasoning_effort`" entry — it lands at the
 * same wire shape as Default but lets callers pin the intent. A model exposes
 * exactly the efforts the catalog credits it with; a model the catalog leaves
 * blank (it decides its own depth) exposes no selector. No default effort is
 * pinned either: absence preserves the gateway's own.
 */
function reasoningFor(model) {
    const levels = (model?.efforts ?? []).filter(effort => effort in GATEWAY_EFFORTS);
    if (levels.length === 0)
        return undefined;
    return {
        efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            ...levels.map(effortInfo),
        ],
    };
}
/**
 * Command Code Go adapter. One instance serves every configured account; the
 * harness model id IS the gateway wire model id.
 */
export class CommandCodeGoAdapter extends LlmAdapter {
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    /**
     * Resolve the request bytes for every image in the conversation. The
     * attachment service is optional: a deployment without one keeps serving
     * text-only traffic and fails loud only when an image actually arrives.
     */
    async prepareRequestImages(messages, signal) {
        const refs = collectRequestImages(messages);
        if (refs.length === 0)
            return undefined;
        const attachments = this.config.resolveAttachments?.();
        if (attachments === undefined) {
            throw new LlmError('image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
        }
        const versions = await Promise.all(refs.map(ref => attachments.readImageRequest(ref, REQUEST_IMAGE_POLICY, signal)));
        return new Map(versions.map(version => [version.attachment.attachmentId, version]));
    }
    providerInfo(provider) {
        return { id: provider, name: this.config.account(provider).displayName };
    }
    providerRetryPolicy(provider) {
        return this.config.account(provider).retryPolicy;
    }
    listModels(provider) {
        return Promise.resolve(this.config.account(provider).models.map(model => modelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        const connection = this.config.account(provider);
        const configured = connection.models.find(entry => entry.id === model);
        const info = configured === undefined
            ? modelInfo(provider, { id: model, name: model })
            : modelInfo(provider, configured);
        const reasoning = reasoningFor(configured);
        return Promise.resolve({
            ...info,
            context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
            defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
            ...reasoning === undefined ? {} : { reasoning },
        });
    }
    async *stream(options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const connection = this.config.account(options.provider);
            const apiKey = await this.config.resolveApiKey(options.provider);
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE), false);
            const iterator = this.request(options, watchdog.signal, connection, apiKey)[Symbol.asyncIterator]();
            let exhausted = false;
            try {
                while (true) {
                    const result = await watchdog.next(iterator);
                    if (result.done) {
                        exhausted = true;
                        return;
                    }
                    yield result.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
                    throw new LlmError(`stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`, 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError(errorChain(error), 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort('Command Code stream consumer stopped');
                if (!exhausted && iterator.return !== undefined) {
                    try {
                        await iterator.return();
                    }
                    catch (_abortedTransportTeardown) {
                        // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
                    }
                }
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async *request(options, signal, connection, apiKey) {
        const images = await this.prepareRequestImages(options.messages, signal);
        const body = buildRequest(options, images);
        const payload = JSON.stringify(body);
        const headers = {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-command-code-version': CC_VERSION,
            'x-cli-environment': 'production',
            'x-co-flag': 'false',
            ...attributionHeaders(),
        };
        let response;
        try {
            response = await fetch(`${connection.baseURL}/alpha/generate`, {
                method: 'POST',
                headers,
                body: payload,
                signal,
            });
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            // errorChain unwraps undici's `TypeError: fetch failed` down to the real
            // socket/DNS/TLS failure, which the message alone would otherwise hide.
            throw new LlmError(errorChain(error), 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            const raw = await response.text().catch(() => '');
            const detail = gatewayErrorDetail(raw);
            throw new LlmError(`${detail ?? raw} [model=${options.model}]`, upstreamErrorCode(response.status, detail ?? raw), { status: response.status });
        }
        if (!response.body) {
            throw new LlmError('returned no response body', 'EMPTY_RESPONSE');
        }
        const state = { blockIndex: 0 };
        for await (const event of parseEventStream(response.body)) {
            // A mid-stream failure arrives as an event, not an HTTP status; its
            // message is the only account of what went wrong.
            if (event.type === 'error') {
                const { detail, status } = streamErrorDetail(event);
                throw new LlmError(`${detail} [model=${options.model}]`, upstreamErrorCode(status ?? 500, detail), status === undefined ? undefined : { status });
            }
            // Each distinct content stream (text / reasoning / tool-call) opens its
            // own block index in arrival order.
            if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
                state.blockIndex += 1;
            }
            yield* eventToChunks(event, state);
            if (event.type === 'finish-step' || event.type === 'finish')
                return;
        }
        // Gateway closed without a finish event: treat as truncated.
        throw new LlmError('stream ended without a finish event', 'STREAM_CLOSED');
    }
}
/**
 * Map a gateway status and error text to a stable harness `LlmError` code.
 * The upstream sentinels come first because the gateway attaches them to
 * several statuses, and each names a failure the status alone gets wrong: the
 * key is fine when the plan is not, and an exhausted balance is terminal
 * where a rate limit is not.
 */
function upstreamErrorCode(status, detail) {
    if (detail.includes('MODEL_NOT_IN_PLAN'))
        return 'PERMISSION';
    if (detail.includes('PREMIUM_CREDITS_EXHAUSTED') || isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 429 || detail.includes('RATE_LIMITED'))
        return 'RATE_LIMIT';
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 400) {
        return isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
