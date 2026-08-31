/**
 * dsh-commandcode-go-provider — Command Code Go provider for the dsh harness.
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
 * @module dsh-commandcode-go-provider
 */
import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey, errorChain, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './adapter.js';
import { fetchCatalog, fetchGoModels } from './models.js';
export { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, } from './adapter.js';
export { fetchCatalog, fetchGoModels, isGoPlan, parseCatalog } from './models.js';
export const name = 'commandcode-go-provider';
export const inject = ['llm', 'settings'];
const NS = settingsNamespace('commandcode-go-provider');
const PROVIDER = 'commandcode';
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY';
/** Default gateway base; `/alpha/generate` is appended. */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai';
export const Config = z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    baseURL: z.string().default(DEFAULT_BASE_URL),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    retryPolicy: RetryPolicySchema,
});
/**
 * The one explicit resolve step from raw config to connection facts. Bounds
 * are the schema's job (`Config` pins every numeric floor), so this only maps.
 */
export function resolveAdapterOptions(config, scanned) {
    return {
        apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        models: scanned,
        retryPolicy: resolveRetryPolicy(config.retryPolicy, 'commandcode-go-provider: retryPolicy'),
    };
}
export function apply(ctx, config) {
    // The live-scanned catalog lives OUTSIDE the settings-backed config so a
    // scan cannot be clobbered by a settings snapshot; the adapter reads the
    // merged view through this thunk.
    let scanned = [];
    let current = () => config;
    let cache;
    const options = () => {
        const raw = current();
        if (cache !== undefined && cache.raw === raw && cache.scanned === scanned) {
            return cache.options;
        }
        const next = resolveAdapterOptions(raw, scanned);
        cache = { raw, scanned, options: next };
        return next;
    };
    const resolveApiKey = async () => {
        const ref = options().apiKeyEnv;
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined)
                return assertUsableApiKey(hit.value, 'commandcode-go-provider', ref);
        }
        else {
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value.length > 0) {
                return assertUsableApiKey(ambient.value, 'commandcode-go-provider', ref);
            }
        }
        throw new LlmError(`commandcode-go-provider: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
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
    /** Scan the Go catalog and swap it into the adapter's view. */
    async function sync() {
        // The official CLI catalog owns the two facts the Provider API withholds:
        // which plan each model belongs to, and which reasoning efforts it takes.
        // Without it there is no honest Go filter, so a failed scan keeps the
        // previous catalog instead of guessing plan membership.
        const next = await fetchGoModels(await fetchCatalog());
        if (next.length === 0) {
            throw new Error('no Go models found; keeping the previous catalog');
        }
        if (deepEqualJson(next, scanned))
            return;
        scanned = next;
        ctx.logger.info('[commandcode-go-provider] synced %d Go model(s): %s', next.length, next.map(m => m.id).join(', '));
    }
    void sync().catch((error) => {
        ctx.logger.warn('[commandcode-go-provider] initial scan failed: %s', errorChain(error));
    });
}
