/**
 * commandcode-go — Command Code Go provider for the dsh harness.
 *
 * A Go-plan subscription has no Provider-API access: the OpenAI-compatible
 * endpoints (`/provider/v1/chat/completions`) answer 403 `upgrade_required`,
 * so every request must go through Command Code's private CLI gateway at
 * `/alpha/generate`. This plugin:
 *
 * 1. Scans the public model catalog (`/provider/v1/models`, open endpoint) and
 *    keeps the models the Go plan includes (open-source plus GPT-5.6 Luna,
 *    Grok 4.5, Muse Spark 1.2 Contributor), re-scanning on an interval. The
 *    Provider API discloses no reasoning metadata, so per-model effort support
 *    is merged from the official `command-code` CLI catalog
 *    (`reference/models.md`, fetched live from jsDelivr).
 * 2. Registers a `commandcode` provider route on `ctx.llm` whose adapter
 *    streams over `/alpha/generate`, so the harness model picker, tools, and
 *    reasoning-effort controls all work against the Go catalog.
 * 3. Resolves the bearer key per request through the credential seam
 *    (default `COMMANDCODE_API_KEY`), failing loud when it is missing.
 *
 * @module commandcode-go
 */
import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './adapter.js';
import { fetchCatalogEfforts, fetchGoModels } from './models.js';
export { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, } from './adapter.js';
export { fetchCatalogEfforts, fetchGoModels, isGoModel, parseCatalogEfforts } from './models.js';
export const name = 'commandcode-go';
export const inject = ['llm'];
const NS = settingsNamespace('commandcode-go');
const PROVIDER = 'commandcode';
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY';
/** Default gateway base; `/alpha/generate` is appended. */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai';
/** Catalog scan cadence; the listing is stable so a slow poll is plenty. */
const REFRESH_MS = 15 * 60 * 1000;
const catalogModel = z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
    efforts: z.array(z.string().step(1)),
});
export const Config = z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    baseURL: z.string().default(DEFAULT_BASE_URL),
    reasoningEffort: z.union(['off', 'high', 'max']),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    models: z.array(catalogModel).default([]),
    streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    retryPolicy: RetryPolicySchema,
});
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
    const seen = new Set();
    return (models ?? []).map((model) => {
        if (model.id.length === 0)
            throw new Error('commandcode-go: catalog model ids must be non-empty');
        if (model.name !== undefined && model.name.length === 0) {
            throw new Error(`commandcode-go: catalog model "${model.id}" has an empty name`);
        }
        if (model.contextWindow !== undefined
            && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
            throw new Error(`commandcode-go: catalog model "${model.id}" contextWindow must be a positive integer`);
        }
        if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
            throw new Error(`commandcode-go: catalog model "${model.id}" maxTokens must be a positive integer`);
        }
        if (model.efforts !== undefined
            && (!Array.isArray(model.efforts)
                || model.efforts.some((effort) => typeof effort !== 'string' || effort.length === 0))) {
            throw new Error(`commandcode-go: catalog model "${model.id}" efforts must be non-empty strings`);
        }
        if (seen.has(model.id))
            throw new Error(`commandcode-go: duplicate catalog model "${model.id}"`);
        seen.add(model.id);
        return {
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
            ...model.efforts === undefined ? {} : { efforts: [...model.efforts] },
        };
    });
}
/** The one explicit resolve step from raw config to validated connection facts. */
export function resolveAdapterOptions(config) {
    if (config.defaultContextWindow !== undefined
        && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
        throw new Error('commandcode-go: defaultContextWindow must be a positive integer');
    }
    if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
        throw new Error('commandcode-go: maxTokens must be a positive safe integer');
    }
    const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(streamIdleTimeoutMs)
        || streamIdleTimeoutMs <= 0
        || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`commandcode-go: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    return {
        apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        reasoningEffort: config.reasoningEffort,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        models: resolveModels(config.models),
        streamIdleTimeoutMs,
        retryPolicy: resolveRetryPolicy(config.retryPolicy, 'commandcode-go: retryPolicy'),
    };
}
export function apply(ctx, config) {
    // The live-scanned catalog lives OUTSIDE the settings-backed config so a
    // scan cannot be clobbered by a settings snapshot; the adapter reads the
    // merged view through this thunk.
    let scanned = [];
    let scannedVersion = 0;
    let current = () => config;
    let lastRaw;
    let lastGood;
    let lastScannedVersion = 0;
    const options = () => {
        const raw = current();
        if (raw === lastRaw && lastScannedVersion === scannedVersion && lastGood !== undefined) {
            return lastGood;
        }
        try {
            const merged = { ...raw, models: [...(raw.models ?? []), ...scanned] };
            const next = resolveAdapterOptions(merged);
            lastRaw = raw;
            lastGood = next;
            lastScannedVersion = scannedVersion;
            return next;
        }
        catch (error) {
            if (lastGood === undefined)
                throw error;
            lastRaw = raw;
            ctx.logger.error('commandcode-go: keeping the last good configuration after an invalid settings section');
            ctx.logger.error(error);
            return lastGood;
        }
    };
    options();
    const resolveApiKey = async () => {
        const ref = options().apiKeyEnv;
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined)
                return assertUsableApiKey(hit.value, 'commandcode-go', ref);
        }
        else {
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value.length > 0) {
                return assertUsableApiKey(ambient.value, 'commandcode-go', ref);
            }
        }
        throw new LlmError(`commandcode-go: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
            + ` service (the web Models page writes it), or export ${ref} in the launching environment`, 'MISSING_CREDENTIAL');
    };
    const adapter = new CommandCodeGoAdapter({ options, resolveApiKey });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: 'Command Code Go', settingsNs: NS, settingsPath: [] },
    ]);
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
    let registeredPolicy = options().retryPolicy;
    const ensureRegistrationFacts = () => {
        const policy = options().retryPolicy;
        if (deepEqualJson(policy, registeredPolicy))
            return;
        registration.replace([PROVIDER]);
        registeredPolicy = policy;
    };
    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => {
            current = source;
        },
        onChange: ensureRegistrationFacts,
    });
    // --- Live catalog scan ---
    let refreshTimer;
    ctx.effect(() => () => {
        if (refreshTimer !== undefined)
            clearInterval(refreshTimer);
        refreshTimer = undefined;
    });
    /** Scan the Go catalog and swap it into the adapter's view. */
    async function sync() {
        const entries = await fetchGoModels();
        if (entries.length === 0) {
            throw new Error('no Go models found; keeping the previous catalog');
        }
        // Effort metadata is best-effort: the model list must survive a catalog
        // hiccup, so a failed catalog fetch degrades to gateway-decided reasoning.
        let efforts = new Map();
        try {
            efforts = await fetchCatalogEfforts();
        }
        catch (error) {
            ctx.logger.warn('[commandcode-go] effort catalog scan failed: %s', error instanceof Error ? error.message : String(error));
        }
        const next = entries.map(entry => ({
            id: entry.id,
            name: entry.name,
            contextWindow: entry.contextWindow,
            ...(efforts.get(entry.id) === undefined ? {} : { efforts: efforts.get(entry.id) }),
        }));
        if (deepEqualJson(next, scanned))
            return;
        scanned = next;
        scannedVersion += 1;
        ctx.logger.info('[commandcode-go] synced %d Go model(s): %s', next.length, next.map(m => m.id).join(', '));
    }
    void sync().catch((error) => {
        ctx.logger.warn('[commandcode-go] initial scan failed: %s', error instanceof Error ? error.message : String(error));
    });
    refreshTimer = setInterval(() => {
        void sync().catch((error) => {
            ctx.logger.warn('[commandcode-go] refresh failed: %s', error instanceof Error ? error.message : String(error));
        });
    }, REFRESH_MS);
    refreshTimer.unref?.();
}
