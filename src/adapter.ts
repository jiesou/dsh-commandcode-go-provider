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
 * @module dsh-commandcode-go-provider/adapter
 */

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  buildRequest,
  CC_VERSION,
  DEFAULT_MAX_TOKENS,
  eventToChunks,
  GATEWAY_EFFORTS,
  gatewayErrorDetail,
  parseEventStream,
  streamErrorDetail,
} from './protocol.js'

/** One catalog model advertised by the adapter. */
export interface CommandCodeGoModel {
  /** Wire model id accepted by the gateway. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Known combined request/response context capacity, when disclosed. */
  contextWindow?: number
  /** Per-request output cap. */
  maxTokens?: number
  /** Reasoning-effort ids the gateway accepts for this model, in display order. */
  efforts?: string[]
}

/** Validated connection facts for one operation. */
export interface CommandCodeGoConnectionOptions {
  /** Credential reference resolved per request. */
  apiKeyEnv: CredentialRef
  /** Gateway base URL; `/alpha/generate` is appended. */
  baseURL: string
  /** Default per-request output cap. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Scanned Go catalog; requests remain unrestricted. */
  models: readonly CommandCodeGoModel[]
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link CommandCodeGoAdapter}. */
export interface CommandCodeGoAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CommandCodeGoConnectionOptions
  /** Resolve the bearer token for one request; throws `MISSING_CREDENTIAL` when unavailable. */
  resolveApiKey: () => Promise<string>
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export { DEFAULT_MAX_TOKENS }

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function effortInfo(effort: string): { id: ReturnType<typeof ReasoningEffortId>, name: string } {
  return { id: ReasoningEffortId(effort), name: GATEWAY_EFFORTS[effort] ?? effort }
}

function modelInfo(provider: string, model: CommandCodeGoModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ['text'],
  }
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
function reasoningFor(model: CommandCodeGoModel | undefined): LlmModelReasoningInfo | undefined {
  const levels = (model?.efforts ?? []).filter(effort => effort in GATEWAY_EFFORTS)
  if (levels.length === 0) return undefined
  return {
    efforts: [
      { id: ReasoningEffortId('off'), name: 'Off' },
      ...levels.map(effortInfo),
    ],
  }
}

/**
 * Command Code Go adapter. One instance serves every model in the scanned Go
 * catalog; the harness model id IS the gateway wire model id.
 */
export class CommandCodeGoAdapter extends LlmAdapter {
  private readonly config: CommandCodeGoAdapterOptions

  constructor(config: CommandCodeGoAdapterOptions) {
    super()
    this.config = config
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code Go' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const info = configured === undefined
      ? modelInfo(provider, { id: model, name: model })
      : modelInfo(provider, configured)
    const reasoning = reasoningFor(configured)
    return Promise.resolve({
      ...info,
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        errorChain(error),
        'TRANSPORT',
        { cause: error },
      )
    } finally {
      consumer.abort('Command Code stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CommandCodeGoConnectionOptions,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const body = buildRequest(options)
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-command-code-version': CC_VERSION,
      'x-cli-environment': 'production',
      'x-co-flag': 'false',
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/alpha/generate`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      // errorChain unwraps undici's `TypeError: fetch failed` down to the real
      // socket/DNS/TLS failure, which the message alone would otherwise hide.
      throw new LlmError(
        errorChain(error),
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const detail = gatewayErrorDetail(raw)
      throw new LlmError(
        `${detail ?? raw} [model=${options.model}]`,
        upstreamErrorCode(response.status, detail ?? raw),
        { status: response.status },
      )
    }
    if (!response.body) {
      throw new LlmError('returned no response body', 'EMPTY_RESPONSE')
    }

    const state = { blockIndex: 0 }
    for await (const event of parseEventStream(response.body)) {
      // A mid-stream failure arrives as an event, not an HTTP status; its
      // message is the only account of what went wrong.
      if (event.type === 'error') {
        const { detail, status } = streamErrorDetail(event)
        throw new LlmError(
          `${detail} [model=${options.model}]`,
          upstreamErrorCode(status ?? 500, detail),
          status === undefined ? undefined : { status },
        )
      }
      // Each distinct content stream (text / reasoning / tool-call) opens its
      // own block index in arrival order.
      if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
        state.blockIndex += 1
      }
      yield* eventToChunks(event, state)
      if (event.type === 'finish-step' || event.type === 'finish') return
    }
    // Gateway closed without a finish event: treat as truncated.
    throw new LlmError('stream ended without a finish event', 'STREAM_CLOSED')
  }
}

/**
 * Map a gateway status and error text to a stable harness `LlmError` code.
 * The upstream sentinels come first because the gateway attaches them to
 * several statuses, and each names a failure the status alone gets wrong: the
 * key is fine when the plan is not, and an exhausted balance is terminal
 * where a rate limit is not.
 */
function upstreamErrorCode(status: number, detail: string): string {
  if (detail.includes('MODEL_NOT_IN_PLAN')) return 'PERMISSION'
  if (detail.includes('PREMIUM_CREDITS_EXHAUSTED') || isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429 || detail.includes('RATE_LIMITED')) return 'RATE_LIMIT'
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 400) {
    return isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}
