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
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
/** Gateway version pinned to a known-good Command Code CLI release. */
export declare const CC_VERSION = "0.26.20";
/** Last-resort output cap when a request carries no maxTokens (matches the adapter default). */
export declare const DEFAULT_MAX_TOKENS = 64000;
/**
 * Reasoning-effort values the gateway accepts (the CLI's own
 * `isReasoningEffort` list), mapped to their selector labels. There is
 * deliberately no `off`: a request that names no effort is what "let the model
 * decide" means on this gateway, so omitting the field IS the default.
 */
export declare const GATEWAY_EFFORTS: Readonly<Record<string, string>>;
/** Line-delimited JSON stream: one JSON object per line (not SSE `data:` framing). */
export interface CcStreamEvent {
    type: string;
    [key: string]: unknown;
}
export interface CcUsage {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: {
        noCacheTokens?: number;
        cacheReadTokens?: number;
    };
    outputTokenDetails?: {
        textTokens?: number;
        reasoningTokens?: number;
    };
}
/** Tool call inside an assistant message, as the gateway wants it. */
interface CcToolCallContent {
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    input: unknown;
}
/** Tool result inside a tool-role message. */
interface CcToolResultContent {
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: {
        type: 'text' | 'error-text';
        value: string;
    };
}
/** One user-content part: text or an inline base64 image. */
type CcUserPart = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    image: string;
    mimeType: string;
};
type CcMessage = {
    role: 'user';
    content: string | CcUserPart[];
} | {
    role: 'assistant';
    content: Array<{
        type: 'text';
        text: string;
    } | {
        type: 'reasoning';
        text: string;
    } | CcToolCallContent>;
} | {
    role: 'tool';
    content: CcToolResultContent[];
};
/** Resolved request bytes per attachment id, prepared by the adapter before serialization. */
export type RequestImages = ReadonlyMap<string, RequestImageAttachment>;
interface CcTool {
    type: 'function';
    name: string;
    description?: string;
    input_schema: unknown;
}
interface CcRequestEnvelope {
    config: {
        workingDir: string;
        date: string;
        environment: string;
        structure: unknown[];
        isGitRepo: boolean;
        currentBranch: string;
        mainBranch: string;
        gitStatus: string;
        recentCommits: unknown[];
    };
    memory: string;
    taste: string;
    skills: null;
    permissionMode: string;
    params: {
        model: string;
        messages: CcMessage[];
        tools: CcTool[];
        system: string;
        max_tokens: number;
        stream: true;
        temperature?: number;
        top_p?: number;
        reasoning_effort?: string;
    };
}
/**
 * The ordered, de-duplicated image refs a request needs bytes for, rejecting
 * images in roles the gateway cannot carry (assistant history).
 */
export declare function collectRequestImages(messages: readonly Message[]): ImageAttachmentRef[];
/** Build the gateway request envelope for one harness call. */
export declare function buildRequest(options: GenerateOptions, images?: RequestImages): CcRequestEnvelope;
/**
 * Translate one gateway stream event into one or more harness StreamChunks.
 * @returns an empty array when the event has no harness representation.
 */
export declare function eventToChunks(event: CcStreamEvent, state: {
    blockIndex: number;
}): StreamChunk[];
/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export declare function parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<CcStreamEvent>;
/**
 * The upstream detail of an in-stream `error` event.
 *
 * A generation that fails after the response headers are sent carries its
 * only failure text in a `{"type":"error","error":{message,statusCode,
 * responseBody,…}}` line — there is no HTTP status left to report, so
 * dropping the event would end the turn with nothing but "stream ended".
 */
export declare function streamErrorDetail(event: CcStreamEvent): {
    detail: string;
    status?: number;
};
/**
 * The upstream detail of a gateway error body, for an `LlmError` message.
 *
 * The gateway answers `{"success":false,"error":{"code","status","message",
 * "docs"}}`, but an edge (Cloudflare) or a proxy can answer HTML or plain text
 * instead. A body carrying no recognizable message is passed through verbatim
 * rather than dropped: an unparsed body still names the failure, while an HTTP
 * status alone names nothing.
 */
export declare function gatewayErrorDetail(body: string): string | undefined;
export {};
