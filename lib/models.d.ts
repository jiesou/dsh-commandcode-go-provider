/**
 * Command Code Go model discovery: pull the live catalog from the public
 * `/provider/v1/models` endpoint and keep only the models a Go-plan
 * subscription can actually call.
 *
 * The listing endpoint is open (no auth required, and a Go key would be
 * refused here anyway — Go has no Provider-API access). It discloses only
 * `id` / `name` / `context_length`; reasoning-effort support is NOT part of
 * the Provider API, so effort metadata is merged from the model catalog the
 * official `command-code` CLI ships (`dist/bundled/command-code-knowledge/
 * reference/models.md`), fetched live from jsDelivr so it tracks the `latest`
 * release instead of a checked-in snapshot.
 *
 * The Go membership rule mirrors the official plans/go page and the opencode
 * commandcode-go plugin:
 * - All open-source models (deepseek, moonshotai, zai-org, MiniMaxAI, xiaomi,
 *   Qwen, stepfun, tencent, nvidia, thinkingmachines, poolside).
 * - A few premium exceptions included outright: GPT-5.6 Luna, Grok 4.5, and
 *   Muse Spark 1.2 Contributor.
 * - Everything else premium (Claude, other GPTs, Gemini, Grok 4.6, Fugu
 *   Ultra, Muse Spark 1.1 / standard 1.2) is excluded.
 *
 * @module commandcode-go/models
 */
export interface GoModel {
    id: string;
    name: string;
    contextWindow: number;
    /** Reasoning-effort ids the gateway accepts for this model, in display order. */
    efforts?: string[];
}
/** Whether a model id is part of the Go plan. */
export declare function isGoModel(id: string): boolean;
/** Parse `reference/models.md` rows into model id → effort list. */
export declare function parseCatalogEfforts(markdown: string): Map<string, string[]>;
/** Fetch the official CLI catalog and extract per-model reasoning efforts. */
export declare function fetchCatalogEfforts(url?: string, fetchImpl?: typeof fetch): Promise<Map<string, string[]>>;
/** Fetch the full catalog and filter to Go-usable models. */
export declare function fetchGoModels(url?: string, fetchImpl?: typeof fetch): Promise<GoModel[]>;
