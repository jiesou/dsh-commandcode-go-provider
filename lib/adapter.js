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
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { buildRequest, CC_VERSION, eventToChunks, gatewayErrorMessage, newThreadId, parseEventStream } from './protocol.js';
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 64_000;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const OFF_REASONING_EFFORT = ReasoningEffortId('off');
const HIGH_REASONING_EFFORT = ReasoningEffortId('high');
const MAX_REASONING_EFFORT = ReasoningEffortId('max');
/** Effort labels in the gateway's own vocabulary, for selector display. */
const EFFORT_LABELS = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
};
function effortInfo(effort) {
    return { id: ReasoningEffortId(effort), name: EFFORT_LABELS[effort] ?? effort };
}
function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: ['text'],
    };
}
/**
 * Build the reasoning-effort selector for one model. Models whose effort
 * support is known expose exactly their supported levels (plus `off`); models
 * without metadata let the gateway choose reasoning depth, so no `reasoning`
 * block is advertised and requests leave `reasoning_effort` unset.
 *
 * The default effort always lands in the model's supported set — the harness
 * rejects a default the model does not advertise. `high` is preferred when
 * supported; otherwise the highest advertised level (the catalog lists
 * efforts ascending) is used. An explicitly configured plugin default wins
 * when it is supported by the model.
 */
function reasoningFor(model, configuredEffort) {
    const efforts = model?.efforts;
    if (efforts === undefined || efforts.length === 0)
        return undefined;
    const selectable = [
        { id: OFF_REASONING_EFFORT, name: EFFORT_LABELS.off },
        ...efforts.map(effortInfo),
    ];
    const configured = configuredEffort === 'off'
        ? OFF_REASONING_EFFORT
        : configuredEffort === 'max'
            ? MAX_REASONING_EFFORT
            : configuredEffort === 'high'
                ? HIGH_REASONING_EFFORT
                : undefined;
    let defaultEffort = configured;
    if (defaultEffort !== undefined) {
        const supported = efforts.some((effort) => ReasoningEffortId(effort) === defaultEffort);
        if (!supported)
            defaultEffort = undefined;
    }
    if (defaultEffort === undefined) {
        defaultEffort = efforts.includes('high')
            ? HIGH_REASONING_EFFORT
            : ReasoningEffortId(efforts[efforts.length - 1]);
    }
    return { efforts: selectable, defaultEffort };
}
/**
 * Command Code Go adapter. One instance serves every model in the scanned Go
 * catalog; the harness model id IS the gateway wire model id.
 */
export class CommandCodeGoAdapter extends LlmAdapter {
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Command Code Go' };
    }
    providerRetryPolicy(_provider) {
        return this.config.options().retryPolicy;
    }
    listModels(provider) {
        return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        const connection = this.config.options();
        const configured = connection.models.find(entry => entry.id === model);
        const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
        const reasoning = reasoningFor(configured, connection.reasoningEffort);
        return Promise.resolve({
            ...configured === undefined
                ? { provider, id: model, name: model, inputModalities: ['text'] }
                : modelInfo(provider, configured),
            context: { contextWindow },
            defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
            ...reasoning === undefined ? {} : { reasoning },
        });
    }
    async *stream(options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const connection = this.config.options();
            const apiKey = await this.config.resolveApiKey();
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
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
                    throw new LlmError(`Command Code stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError('Command Code /alpha/generate stream failed', 'TRANSPORT', { cause: error });
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
        const body = buildRequest(options);
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
            throw new LlmError(`Command Code request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            const raw = await response.text().catch(() => '');
            const message = gatewayErrorMessage(raw) ?? `Command Code API error (HTTP ${response.status})`;
            throw new LlmError(`${message} [model=${options.model}]`, httpErrorCode(response.status, raw), { status: response.status });
        }
        if (!response.body) {
            throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE');
        }
        const state = { blockIndex: 0 };
        for await (const event of parseEventStream(response.body)) {
            // Each distinct content stream (text / reasoning / tool-call) opens its
            // own block index in arrival order.
            if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
                state.blockIndex += 1;
            }
            yield* eventToChunks(event, state);
            if (event.type === 'finish-step')
                return;
        }
        // Gateway closed without a finish-step: treat as truncated.
        throw new LlmError('Command Code stream ended without finish-step', 'STREAM_CLOSED');
    }
}
/** Map a gateway HTTP status / error body to a stable harness LlmError code. */
function httpErrorCode(status, body) {
    if (status === 401 || status === 403) {
        // MODEL_NOT_IN_PLAN is a plan/permission failure, not a credential one:
        // the key is fine, the selected model is above the Go tier.
        if (body.includes('MODEL_NOT_IN_PLAN'))
            return 'PERMISSION';
        return 'AUTH';
    }
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(body))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
// Keep `newThreadId` reachable for future streaming-id wiring (some gateway
// revisions expect the threadId echoed in follow-up requests).
export { newThreadId };
