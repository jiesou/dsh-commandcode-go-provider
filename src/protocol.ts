/**
 * Command Code Go wire protocol: translate between the harness LLM vocabulary
 * and Command Code's private `/alpha/generate` gateway.
 *
 * The Go plan is the only Command Code plan without Provider-API access, so
 * the standard OpenAI-compatible endpoints answer 403 `upgrade_required` for
 * a Go subscription. The CLI gateway at `POST /alpha/generate` is the
 * transport every Go-plan request must use. This module serializes the
 * gateway request body and parses its line-delimited JSON stream back into
 * harness `StreamChunk`s.
 *
 * The request envelope shape mirrors the `cmd` CLI (`command-code` npm
 * package) and the opencode commandcode-go provider plugin:
 * - `config.environment` is a plain string (`<os>-<arch>`), not an object.
 * - Gateway compatibility rides on the `x-command-code-version` header.
 *
 * @module dsh-commandcode-go-provider/protocol
 */

import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { platform, arch } from 'node:os'

/** Gateway version pinned to a known-good Command Code CLI release. */
export const CC_VERSION = '0.26.20'

/** Last-resort output cap when a request carries no maxTokens (matches the adapter default). */
export const DEFAULT_MAX_TOKENS = 64_000

/**
 * Reasoning-effort values the gateway accepts (the CLI's own
 * `isReasoningEffort` list), mapped to their selector labels. There is
 * deliberately no `off`: a request that names no effort is what "let the model
 * decide" means on this gateway, so omitting the field IS the default.
 */
export const GATEWAY_EFFORTS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/** Line-delimited JSON stream: one JSON object per line (not SSE `data:` framing). */
export interface CcStreamEvent {
  type: string
  [key: string]: unknown
}

export interface CcUsage {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
  }
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
}

/** Tool call inside an assistant message, as the gateway wants it. */
interface CcToolCallContent {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

/** Tool result inside a tool-role message. */
interface CcToolResultContent {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text' | 'error-text'; value: string }
}

/** One user-content part: text or an inline base64 image. */
type CcUserPart = { type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }

type CcMessage =
  | { role: 'user'; content: string | CcUserPart[] }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'reasoning'; text: string } | CcToolCallContent> }
  | { role: 'tool'; content: CcToolResultContent[] }

/** Resolved request bytes per attachment id, prepared by the adapter before serialization. */
export type RequestImages = ReadonlyMap<string, RequestImageAttachment>

interface CcTool {
  type: 'function'
  name: string
  description?: string
  input_schema: unknown
}

interface CcRequestEnvelope {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: string
  params: {
    model: string
    messages: CcMessage[]
    tools: CcTool[]
    system: string
    max_tokens: number
    stream: true
    temperature?: number
    top_p?: number
    reasoning_effort?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The flattened text of a message's content blocks. */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** The attachment refs of the image blocks in one content list. */
function imageRefs(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
    .map(block => block.attachment)
}

/**
 * The text value of one tool result. Images nested in it are deliberately not
 * carried here: the gateway's tool output is text-only, so they ride the user
 * turn {@link serializeUser} appends after it. A text-only route never sees
 * them at all — the harness projects nested images to placeholder text first.
 */
function toolResultOutput(
  result: Extract<ContentBlock, { type: 'tool-result' }>,
): CcToolResultContent['output'] {
  const value = flattenText(result.content)
  return result.isError
    ? { type: 'error-text', value: value || 'Execution denied' }
    : { type: 'text', value: value || '(no output)' }
}

function serializeAssistant(message: Message): Extract<CcMessage, { role: 'assistant' }> {
  const parts: Extract<CcMessage, { role: 'assistant' }>['content'] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: block.text })
    } else if (block.type === 'image') {
      throw new LlmError('the gateway cannot represent an image in assistant history', 'UNSUPPORTED_CONTENT')
    } else if (block.type === 'tool-call') {
      parts.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: safeParseJson(block.arguments),
      })
    }
  }
  return { role: 'assistant', content: parts }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** One inline image part, in the exact wire shape the CLI's `toWireMessages` emits. */
function imagePart(ref: ImageAttachmentRef, images: RequestImages | undefined): CcUserPart {
  const version = images?.get(ref.attachmentId)
  if (version === undefined) {
    throw new LlmError(`no request bytes resolved for image attachment ${ref.attachmentId}`, 'MISSING_ATTACHMENT')
  }
  return {
    type: 'image',
    image: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
    mimeType: version.mediaType,
  }
}

/**
 * One harness user message as gateway turns. Images a tool returned cannot
 * ride the gateway's text-only tool output, so they follow the results as a
 * plain user turn — the only role the gateway carries inline images in.
 */
function serializeUser(message: Message, images: RequestImages | undefined): CcMessage[] {
  const toolResults = message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
  )
  const nested = toolResults.flatMap(result => imageRefs(result.content))
  if (toolResults.length > 0 && flattenText(message.content).length === 0) {
    const wire: CcMessage[] = [{
      role: 'tool',
      content: toolResults.map(result => ({
        type: 'tool-result' as const,
        toolCallId: result.toolCallId,
        toolName: 'unknown',
        output: toolResultOutput(result),
      })),
    }]
    if (nested.length > 0) wire.push({ role: 'user', content: nested.map(ref => imagePart(ref, images)) })
    return wire
  }
  // Text and image parts keep their block order, like the CLI's own user
  // serialization; a text-only message keeps the flat string shape.
  const parts: CcUserPart[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') parts.push(imagePart(block.attachment, images))
  }
  for (const ref of nested) parts.push(imagePart(ref, images))
  if (parts.every(part => part.type === 'text')) {
    return [{ role: 'user', content: parts.map(part => (part as { text: string }).text).join('') }]
  }
  return [{ role: 'user', content: parts }]
}

/**
 * The ordered, de-duplicated image refs a request needs bytes for, rejecting
 * images in roles the gateway cannot carry (assistant history).
 */
export function collectRequestImages(messages: readonly Message[]): ImageAttachmentRef[] {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `a ${message.role} message carries an image the gateway cannot replay`,
        'UNSUPPORTED_CONTENT',
      )
    }
    for (const ref of [
      ...imageRefs(message.content),
      ...message.content.flatMap(block => block.type === 'tool-result' ? imageRefs(block.content) : []),
    ]) {
      refs.set(ref.attachmentId, ref)
    }
  }
  return [...refs.values()]
}

/** Build the gateway request envelope for one harness call. */
export function buildRequest(options: GenerateOptions, images?: RequestImages): CcRequestEnvelope {
  let system = options.system ?? ''
  const messages: CcMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + flattenText(message.content)
      continue
    }
    if (message.role === 'assistant') messages.push(serializeAssistant(message))
    else messages.push(...serializeUser(message, images))
  }

  const tools: CcTool[] = (options.tools ?? [])
    .map((tool: ToolSchema) => ({
      type: 'function' as const,
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      input_schema: tool.parameters,
    }))

  const params: CcRequestEnvelope['params'] = {
    model: options.model,
    messages,
    tools,
    system,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (options.temperature !== undefined) params.temperature = options.temperature
  // An effort the gateway has no value for (a stale `off` from an older
  // selector) is dropped rather than rejected upstream.
  if (options.reasoningEffort !== undefined && options.reasoningEffort in GATEWAY_EFFORTS) {
    params.reasoning_effort = options.reasoningEffort
  }

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0],
      environment: `${platform()}-${arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params,
  }
}

/**
 * Translate one gateway stream event into one or more harness StreamChunks.
 * @returns an empty array when the event has no harness representation.
 */
export function eventToChunks(
  event: CcStreamEvent,
  state: { blockIndex: number },
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  switch (event.type) {
    case 'text-start': {
      chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'text' })
      break
    }
    case 'text-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length > 0) {
        chunks.push({ type: 'text-delta', index: state.blockIndex, text })
      }
      break
    }
    case 'reasoning-start': {
      chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'reasoning' })
      break
    }
    case 'reasoning-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length > 0) {
        chunks.push({ type: 'reasoning-delta', index: state.blockIndex, text })
      }
      break
    }
    case 'tool-call': {
      const input = event.input ?? event.args ?? event.arguments
      const callId = typeof event.toolCallId === 'string' ? event.toolCallId
        : typeof event.id === 'string' ? event.id
          : ''
      chunks.push({
        type: 'tool-call-delta',
        index: state.blockIndex,
        id: CallId(callId),
        ...typeof event.toolName === 'string' ? { name: event.toolName } : {},
        argumentsDelta: JSON.stringify(input ?? {}),
      })
      break
    }
    // The gateway ends a step with `finish-step`; the CLI's own reader also
    // accepts a bare `finish` carrying `totalUsage`, so both terminate here.
    case 'finish-step':
    case 'finish': {
      const raw = event.usage ?? event.totalUsage
      const usage = isRecord(raw) ? raw as unknown as CcUsage : undefined
      if (usage) {
        const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : undefined
        const cacheRead = inputDetails?.cacheReadTokens
        const totalInput = usage.inputTokens
        const noCache = inputDetails?.noCacheTokens
        const inputTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
          ? Math.max(0, totalInput - cacheRead)
          : totalInput) ?? 0
        const outputTokens = usage.outputTokens ?? outputDetails?.textTokens ?? 0
        chunks.push({
          type: 'usage',
          usage: {
            inputTokens,
            outputTokens,
            ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
            ...outputDetails?.reasoningTokens !== undefined ? { reasoningTokens: outputDetails.reasoningTokens } : {},
          },
        })
      }
      const reason = event.finishReason ?? event.rawFinishReason ?? 'stop'
      chunks.push({ type: 'finish', reason: mapFinishReason(reason) })
      break
    }
  }
  return chunks
}

/** Map the gateway finish-reason vocabulary to the harness FinishReason. */
function mapFinishReason(raw: unknown): FinishReason {
  const reason = typeof raw === 'string' ? raw : 'stop'
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
    case 'max-output-tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

function parseEventLine(line: string): CcStreamEvent | undefined {
  if (line.length === 0 || line.startsWith(':')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isRecord(parsed) && typeof parsed.type === 'string' ? parsed as unknown as CcStreamEvent : undefined
}

/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<CcStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? '' : decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event !== undefined) yield event
      }
      if (done) {
        const tail = buffer.trim()
        const event = parseEventLine(tail)
        if (event !== undefined) yield event
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Upstream body budget carried into one error message (pi-ai's own cap). */
const MAX_ERROR_BODY_CHARS = 4000

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The upstream detail of an in-stream `error` event.
 *
 * A generation that fails after the response headers are sent carries its
 * only failure text in a `{"type":"error","error":{message,statusCode,
 * responseBody,…}}` line — there is no HTTP status left to report, so
 * dropping the event would end the turn with nothing but "stream ended".
 */
export function streamErrorDetail(event: CcStreamEvent): { detail: string, status?: number } {
  const error = isRecord(event.error) ? event.error : event
  const body = nonEmptyString(error.responseBody)
  const message = nonEmptyString(error.message)
    ?? (body === undefined ? undefined : gatewayErrorDetail(body))
    ?? JSON.stringify(event)
  const status = typeof error.statusCode === 'number' && Number.isInteger(error.statusCode)
    ? error.statusCode
    : undefined
  const detail = body === undefined || message.includes(body) ? message : `${message}: ${body}`
  return {
    detail: detail.slice(0, MAX_ERROR_BODY_CHARS),
    ...status === undefined ? {} : { status },
  }
}

/**
 * The upstream detail of a gateway error body, for an `LlmError` message.
 *
 * The gateway answers `{"success":false,"error":{"code","status","message",
 * "docs"}}`, but an edge (Cloudflare) or a proxy can answer HTML or plain text
 * instead. A body carrying no recognizable message is passed through verbatim
 * rather than dropped: an unparsed body still names the failure, while an HTTP
 * status alone names nothing.
 */
export function gatewayErrorDetail(body: string): string | undefined {
  const trimmed = body.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed.slice(0, MAX_ERROR_BODY_CHARS)
  }
  const envelope = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed
  const message = isRecord(envelope)
    ? nonEmptyString(envelope.message) ?? nonEmptyString(envelope.detail)
    : nonEmptyString(envelope)
  if (message === undefined) return trimmed.slice(0, MAX_ERROR_BODY_CHARS)
  const code = isRecord(envelope) ? nonEmptyString(envelope.code) : undefined
  return code === undefined || message.includes(code) ? message : `${message} [${code}]`
}
