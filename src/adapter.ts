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

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  requiredImageOffload,
  resolveImageAttachmentAccess,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  ImageBlock,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  buildRequest,
  CC_VERSION,
  chunkState,
  collectRequestImages,
  DEFAULT_MAX_TOKENS,
  eventToChunks,
  GATEWAY_EFFORTS,
  gatewayErrorDetail,
  parseEventStream,
  streamErrorDetail,
} from './protocol.js'
import type { RequestImages } from './protocol.js'

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
  /** Whether the model accepts image input; absent means unknown (no modality is declared). */
  imageInput?: boolean
}

/** Validated connection facts for one account (one provider route). */
export interface CommandCodeGoConnectionOptions {
  /** Picker/directory label for this account. */
  displayName: string
  /** Credential reference resolved per request. */
  apiKeyEnv: CredentialRef
  /** Gateway base URL; `/alpha/generate` is appended. */
  baseURL: string
  /** Default per-request output cap. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Inline base64 image bytes one request accepts before it must be offloaded. */
  maxRequestImageBytes: number
  /** Scanned Go catalog; requests remain unrestricted. */
  models: readonly CommandCodeGoModel[]
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link CommandCodeGoAdapter}. */
export interface CommandCodeGoAdapterOptions {
  /** Current validated connection facts for one account; called once per operation. */
  account: (provider: string) => CommandCodeGoConnectionOptions
  /** Resolve the bearer token for one account; throws `MISSING_CREDENTIAL` when unavailable. */
  resolveApiKey: (provider: string) => Promise<string>
  /**
   * The durable attachment service, resolved lazily so a deployment without
   * one keeps working for text-only traffic.
   */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Map one durable image's stored host object into the current tool execution
   * world, so an offloaded occurrence still names a path the model can read.
   */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/**
 * Default inline image budget for one request, deliberately below the official
 * pi-ai adapter's 20 MiB: the gateway stream is stateless, so every retained
 * image rides every turn again, and a smaller budget keeps a long conversation
 * from re-sending megabytes of images on each request.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 4_194_304
export { DEFAULT_MAX_TOKENS }

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * Per-image request budget: the full 2048px normalized attachment, re-encoded
 * to fit 512KiB per image.
 */
const REQUEST_IMAGE_POLICY = { maxPixels: 4_194_304, maxBytes: 524_288 }

/**
 * Deterministic request target for one source image under the route budgets.
 * Both spellings of the same budget ride along: dsh >= 0.1.6 reads
 * `width`/`height`, earlier releases read `maxPixels`, and each validates only
 * the fields it knows, so one target serves either runtime.
 */
function requestImageTarget(ref: ImageAttachmentRef): ImageRequestTarget & { maxPixels: number } {
  return {
    ...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_POLICY.maxPixels),
    maxPixels: REQUEST_IMAGE_POLICY.maxPixels,
    maxBytes: REQUEST_IMAGE_POLICY.maxBytes,
  }
}

function effortInfo(effort: string): { id: ReturnType<typeof ReasoningEffortId>, name: string } {
  return { id: ReasoningEffortId(effort), name: GATEWAY_EFFORTS[effort] ?? effort }
}

/**
 * The exact base64 length of one request image, which is the representation the
 * gateway carries: every occurrence of a shared attachment counts again.
 * @param bytes - encoded byte length of the request version.
 * @returns the base64 character count.
 */
function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

/** Exact base64 length of one attachment's resolved request version. */
function requestImageVersions(
  versions: readonly RequestImageAttachment[],
): (block: ImageBlock) => number {
  const lengths = new Map(versions.map(version => [version.attachment.attachmentId, version.bytes]))
  return (block) => {
    const bytes = lengths.get(block.attachment.attachmentId)
    if (bytes === undefined) {
      throw new LlmError(`no request bytes resolved for image attachment ${block.attachment.attachmentId}`, 'MISSING_ATTACHMENT')
    }
    return base64Length(bytes)
  }
}

function modelInfo(provider: string, model: CommandCodeGoModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    // An explicit omission is negative capability; an unknown model declares
    // nothing rather than guessing the endpoint (the two wrong answers do not
    // cost the same: over-claiming leaves a durable message no request can
    // replay, under-claiming refuses the image while it is still cheap).
    ...model.imageInput === undefined ? {} : { inputModalities: model.imageInput ? ['text', 'image'] : ['text'] },
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
 * Command Code Go adapter. One instance serves every configured account; the
 * harness model id IS the gateway wire model id.
 */
export class CommandCodeGoAdapter extends LlmAdapter {
  private readonly config: CommandCodeGoAdapterOptions

  constructor(config: CommandCodeGoAdapterOptions) {
    super()
    this.config = config
  }

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
  private async prepareRequestImages(
    messages: RequestMessage[],
    signal: AbortSignal | undefined,
    maxRequestImageBytes: number,
  ): Promise<RequestImages | undefined> {
    const refs = collectRequestImages(messages)
    if (refs.length === 0) return undefined
    const attachments = this.config.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError('image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const versions = await Promise.all(refs.map(ref => attachments.readImageRequest(ref, requestImageTarget(ref), signal)))
    const offloadImages = requiredImageOffload(messages, {
      representation: 'base64',
      maxBytes: maxRequestImageBytes,
    }, requestImageVersions(versions))
    if (offloadImages > 0) {
      throw new LlmError(
        `commandcode-go request images exceed the ${maxRequestImageBytes}-byte base64 budget;`
        + ` ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
    return new Map(versions.map(version => [version.attachment.attachmentId, version]))
  }

  /**
   * The one projection every request shares: an offloaded occurrence reaches
   * the gateway as placeholder text instead of bytes, and only retained
   * occurrences are resolved, encoded, and sent.
   */
  private requestMessages(messages: RequestMessage[]): RequestMessage[] {
    const attachments = this.config.resolveAttachments?.()
    const resolveImageAccess = this.config.resolveImageAccess
    const projected = projectOffloadedImages(messages, (ref) => offloadedImageText(
      ref,
      attachments === undefined || resolveImageAccess === undefined
        ? undefined
        : resolveImageAccess(attachments, ref),
    ))
    return projected === messages ? messages : [...projected]
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.account(provider).displayName }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.config.account(provider).retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.account(provider).models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.account(provider)
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
    const connection = this.config.account(options.provider)
    const apiKey = await this.config.resolveApiKey(options.provider)
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
    const messages = this.requestMessages(options.messages)
    const images = await this.prepareRequestImages(messages, signal, connection.maxRequestImageBytes)
    const body = buildRequest({ ...options, messages }, images)
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

    const state = chunkState()
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
      // Only `finish` terminates: the gateway always precedes it with a
      // `finish-step` carrying the step usage, and the CLI's own reader also
      // waits for the bare `finish` carrying `totalUsage`.
      if (event.type === 'finish') return
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
