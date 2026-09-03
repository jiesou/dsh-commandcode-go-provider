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
/**
 * Model ids the official `command-code` CLI classifies as text-only (its
 * bundled `isKnownTextOnlyModel` denylist). Every id outside this set is
 * image-capable: the CLI's own fallback for models its bundled registry does
 * not explicitly declare is "vision capable unless known text-only", and the
 * Go catalog carries no modality column of its own.
 */
const TEXT_ONLY_MODELS = new Set([
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-flash-fast',
    'zai-org/glm-5.3',
    'zai-org/glm-5.2',
    'zai-org/glm-5.2-fast',
    'zai-org/glm-5.1',
    'zai-org/glm-5',
    'minimaxai/minimax-m2.7',
    'minimax/minimax-m2.7-free',
    'minimaxai/minimax-m2.5',
    'xiaomi/mimo-v2.5-pro',
    'qwen/qwen3.6-max-preview',
    'qwen/qwen3.7-max',
    'stepfun/step-3.5-flash',
    'tencent/hy4-preview',
    'tencent/hy3',
    'tencent/hy3-paid',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'poolside/laguna-s-2.1-free',
    'inclusionai/ling-3.0-flash-free',
    'xai/grok-4.6',
]);
/** The CLI additionally ignores a trailing `-YYYYMMDD` deployment suffix when matching. */
function canonicalModelId(id) {
    return id.toLowerCase().replace(/-\d{8}$/, '');
}
/** Whether a model id accepts image input under the official CLI's classification. */
export function imageCapable(id) {
    return !TEXT_ONLY_MODELS.has(canonicalModelId(id));
}
/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144;
/** Whether a catalog row's `Min plan` column includes the Go plan. */
export function isGoPlan(entry) {
    return entry?.minPlan.split(/\s+/)[0] === 'Go';
}
/**
 * The listing reuses one display name across the paid and free tier of the
 * same model (`MiniMaxAI/MiniMax-M3` and `minimax/minimax-m3-free` are both
 * "MiniMax M3"). Free tiers are marked by a `-free` id suffix, so surface that
 * in the name to keep the two apart.
 */
export function displayName(id, name) {
    return id.endsWith('-free') && !/free/i.test(name) ? `${name} (free)` : name;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Parse the effort column of the official CLI model catalog
 * (`reference/models.md`). The column is a comma-separated list such as
 * `low, medium, high, xhigh, max`; a dash (`—`) means the model decides its
 * own reasoning depth (no explicit effort selectors).
 */
function parseEfforts(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === '—' || trimmed === '-')
        return undefined;
    return trimmed
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}
/** Parse `reference/models.md` rows into model id → catalog entry. */
export function parseCatalog(markdown) {
    const byId = new Map();
    // Row shape: | `id` | Name | Context | Efforts | $/1M … | Min plan | Best for |
    for (const line of markdown.split('\n')) {
        if (!line.trimStart().startsWith('|'))
            continue;
        const cells = line.split('|').map((cell) => cell.trim());
        // Only data rows quote their id, which skips header and separator rows.
        const id = cells[1]?.startsWith('`') === true ? cells[1].replace(/`/g, '') : undefined;
        const minPlan = nonEmptyString(cells[6]);
        if (id === undefined || minPlan === undefined)
            continue;
        const efforts = parseEfforts(cells[4] ?? '');
        byId.set(id, { minPlan, ...efforts === undefined ? {} : { efforts } });
    }
    return byId;
}
const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';
/** Official CLI catalog served from npm; `@latest` tracks new releases. */
const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md';
/** Per-request fetch budget for the upstream catalog endpoints. */
const FETCH_TIMEOUT_MS = 30_000;
/** Fetch the official CLI catalog: per-model plan membership and reasoning efforts. */
export async function fetchCatalog(url = CATALOG_URL, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
        headers: { accept: 'text/markdown' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code catalog answered HTTP ${response.status}`);
    }
    return parseCatalog(await response.text());
}
/** Fetch the live listing and keep the models the catalog puts on the Go plan. */
export async function fetchGoModels(catalog, url = DEFAULT_MODELS_URL, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code models endpoint answered HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error('Command Code models endpoint returned an unexpected shape');
    }
    const models = [];
    for (const raw of payload.data) {
        if (!isRecord(raw))
            continue;
        const id = nonEmptyString(raw.id);
        const entry = id === undefined ? undefined : catalog.get(id);
        if (id === undefined || !isGoPlan(entry))
            continue;
        const name = displayName(id, nonEmptyString(raw.name) ?? id.split('/').pop() ?? id);
        const contextWindow = positiveNumber(raw.context_length)
            ?? positiveNumber(raw.context_window)
            ?? FALLBACK_CONTEXT_WINDOW;
        models.push({
            id,
            name,
            contextWindow,
            imageInput: imageCapable(id),
            ...entry?.efforts === undefined ? {} : { efforts: entry.efforts },
        });
    }
    // Stable order keeps the diff against a persisted catalog deterministic.
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
}
