/**
 * Command Code Go model discovery: pull the live catalog from the public
 * `/provider/v1/models` endpoint and keep only the models a Go-plan
 * subscription can actually call.
 *
 * The listing endpoint is open (no auth required, and a Go key would be
 * refused here anyway — Go has no Provider-API access). It discloses only
 * `id` / `name` / `context_length`: neither plan membership nor reasoning
 * support is part of the Provider API. Both come from the model catalog the
 * official `command-code` CLI ships (`dist/bundled/command-code-knowledge/
 * reference/models.md`), fetched live from jsDelivr so it tracks the `latest`
 * release instead of a checked-in snapshot.
 *
 * Go membership is therefore read, not guessed: the catalog's `Min plan`
 * column names the lowest plan each model belongs to (`Go and above`, `Pro
 * and above`, `GOAT and above`, `Max`), which covers the premium models Go
 * includes outright without a hand-maintained exception list.
 *
 * @module dsh-commandcode-go-provider/models
 */
export interface GoModel {
    id: string;
    name: string;
    contextWindow: number;
    /** Reasoning-effort ids the gateway accepts for this model, in display order. */
    efforts?: string[];
    /** Whether the model accepts image input per the official CLI's own vision data. */
    imageInput: boolean;
}
/** Whether a model id accepts image input under the official CLI's classification. */
export declare function imageCapable(id: string): boolean;
/** One row of the official CLI catalog (`reference/models.md`). */
export interface CatalogEntry {
    /** Lowest plan that includes the model, verbatim (`Go and above`, `Max`, …). */
    minPlan: string;
    /** Reasoning-effort ids the gateway accepts, in catalog order; absent when the model decides. */
    efforts?: string[];
}
/** Whether a catalog row's `Min plan` column includes the Go plan. */
export declare function isGoPlan(entry: CatalogEntry | undefined): boolean;
/**
 * The listing reuses one display name across the paid and free tier of the
 * same model (`MiniMaxAI/MiniMax-M3` and `minimax/minimax-m3-free` are both
 * "MiniMax M3"). Free tiers are marked by a `-free` id suffix, so surface that
 * in the name to keep the two apart.
 */
export declare function displayName(id: string, name: string): string;
/** Parse `reference/models.md` rows into model id → catalog entry. */
export declare function parseCatalog(markdown: string): Map<string, CatalogEntry>;
/** Fetch the official CLI catalog: per-model plan membership and reasoning efforts. */
export declare function fetchCatalog(url?: string, fetchImpl?: typeof fetch): Promise<Map<string, CatalogEntry>>;
/** Fetch the live listing and keep the models the catalog puts on the Go plan. */
export declare function fetchGoModels(catalog: ReadonlyMap<string, CatalogEntry>, url?: string, fetchImpl?: typeof fetch): Promise<GoModel[]>;
