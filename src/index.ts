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
 * 2. Registers one configurable provider route per configured account (the
 *    `accounts` dictionary; a single default account when it is absent) whose
 *    adapter streams over `/alpha/generate`, so the harness model picker,
 *    tools, and reasoning-effort controls all work against the Go catalog —
 *    once per account, sharing one scanned catalog.
 * 3. Resolves each account's bearer key per request through the credential
 *    seam (default `COMMANDCODE_API_KEY`), failing loud when it is missing.
 *
 * @module dsh-commandcode-go-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, errorChain, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './adapter.js'
import type { CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js'
import { fetchCatalog, fetchGoModels } from './models.js'

export {
  CommandCodeGoAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.js'
export type { CommandCodeGoAdapterOptions, CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js'
export { fetchCatalog, fetchGoModels, imageCapable, isGoPlan, parseCatalog } from './models.js'
export type { CatalogEntry, GoModel } from './models.js'
export { chunkState } from './protocol.js'
export type { ChunkState } from './protocol.js'

export const name = 'commandcode-go-provider'
export const inject = ['llm']

const DEFAULT_PROVIDER = 'commandcode'
const DEFAULT_DISPLAY_NAME = 'Command Code Go'
const DEFAULT_SETTINGS_NS = 'commandcode-go-provider'
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** Default gateway base; `/alpha/generate` is appended. */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai'

/**
 * One account's overrides. Every field defaults to the top-level field of the
 * same name, so the top-level config doubles as the shared default.
 */
export interface AccountProfile {
  /** Picker/directory label; defaults to the account key. */
  displayName?: string
  /** Credential reference resolved per request; defaults to the top-level `apiKeyEnv`. */
  apiKeyEnv?: string
  /** Gateway base URL; defaults to the top-level `baseURL`. */
  baseURL?: string
  /** Default per-request output cap; defaults to the top-level `maxTokens`. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value; defaults to the top-level value. */
  defaultContextWindow?: number
  /** Provider-owned model-request retry policy; defaults to the top-level `retryPolicy`. */
  retryPolicy?: RetryPolicyConfig
}

/**
 * Plugin configuration, validated by the same-named schemastery schema and
 * doubling as the `dsh-commandcode-go-provider` settings-section shape.
 */
export interface Config {
  /** Named accounts; each key becomes an independent provider route. Absent or empty = one account from the top-level fields. */
  accounts?: Record<string, AccountProfile>
  /** Credential reference resolved per request; defaults to `COMMANDCODE_API_KEY`. Also every account's default. */
  apiKeyEnv?: string
  /** Gateway base URL; defaults to `https://api.commandcode.ai`. Also every account's default. */
  baseURL?: string
  /** Default per-request output cap (default 64,000); explicit request values win. Also every account's default. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). Also every account's default. */
  defaultContextWindow?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. Also every account's default. */
  retryPolicy?: RetryPolicyConfig
}

export const AccountProfile: z<AccountProfile> = z.object({
  displayName: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  defaultContextWindow: z.number().step(1).min(1),
  retryPolicy: RetryPolicySchema,
})

export const Config: z<Config> = z.object({
  accounts: z.dict(AccountProfile).default({}),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  retryPolicy: RetryPolicySchema,
})

/** Resolved connection facts per provider route, keyed by route id. */
export type ResolvedAccounts = Map<string, CommandCodeGoConnectionOptions>

/** Whether the config declares named accounts rather than the default single one. */
function multiAccount(config: Config): boolean {
  return Object.keys(config.accounts ?? {}).length > 0
}

/**
 * The one explicit resolve step from raw config to per-route connection
 * facts. An absent or empty `accounts` dictionary means one synthetic default
 * account on the top-level fields; otherwise every key is a route and the
 * top-level fields are each account's shared defaults. Bounds are the
 * schema's job, so this only maps.
 */
export function resolveAccounts(config: Config, scanned: readonly CommandCodeGoModel[]): ResolvedAccounts {
  const declared = Object.entries(config.accounts ?? {})
  const routes: readonly (readonly [string, AccountProfile | undefined])[] = declared.length === 0
    ? [[DEFAULT_PROVIDER, undefined]]
    : declared
  return new Map(routes.map(([key, profile]) => [key, {
    // The synthetic single account keeps the product label; a declared
    // account falls back to its own key, like the official pi-ai adapter.
    displayName: profile?.displayName ?? (profile === undefined ? DEFAULT_DISPLAY_NAME : key),
    apiKeyEnv: credentialRef(profile?.apiKeyEnv ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: profile?.baseURL ?? config.baseURL ?? DEFAULT_BASE_URL,
    maxTokens: profile?.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: profile?.defaultContextWindow ?? config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: scanned,
    retryPolicy: resolveRetryPolicy(profile?.retryPolicy ?? config.retryPolicy, 'commandcode-go-provider: retryPolicy'),
  }]))
}

export function apply(ctx: Context, config: Config): void {
  // The live-scanned catalog lives OUTSIDE the settings-backed config so a
  // scan cannot be clobbered by a settings snapshot; every account reads the
  // merged view through this thunk.
  let scanned: CommandCodeGoModel[] = []
  let current: () => Config = () => config
  let cache: { raw: Config; scanned: readonly CommandCodeGoModel[]; accounts: ResolvedAccounts } | undefined
  const accounts = (): ResolvedAccounts => {
    const raw = current()
    if (cache !== undefined && cache.raw === raw && cache.scanned === scanned) {
      return cache.accounts
    }
    const next = resolveAccounts(raw, scanned)
    cache = { raw, scanned, accounts: next }
    return next
  }

  const resolveApiKey = async (provider: string): Promise<string> => {
    const account = accounts().get(provider)
    if (account === undefined) {
      throw new LlmError(`commandcode-go-provider: provider route "${provider}" has no account`, 'INVALID_ADAPTER')
    }
    const ref = account.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'commandcode-go-provider', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'commandcode-go-provider', ref)
      }
    }
    throw new LlmError(
      `commandcode-go-provider: no API key for provider route "${provider}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CommandCodeGoAdapter({
    account: (provider) => {
      const account = accounts().get(provider)
      if (account === undefined) {
        throw new LlmError(`commandcode-go-provider: provider route "${provider}" has no account`, 'INVALID_ADAPTER')
      }
      return account
    },
    resolveApiKey,
    // Resolved lazily at request time: the service is present in every web
    // deployment, and a context without one degrades to the adapter's clear
    // image error instead of a raw cordis trap message.
    resolveAttachments: () => {
      try {
        return ctx.get('attachments')
      } catch {
        return undefined
      }
    },
  })

  /**
   * Directory entries: one configurable provider per account. Sorted by
   * route id, so a settings write that merely reorders keys is not mistaken
   * for a change. The single account addresses the section root (the stored
   * shape it has always had); declared accounts address their own
   * `accounts.<key>` scope, like the official pi-ai adapter.
   */
  const directoryEntries = () => [...accounts().entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, account]) => ({
      provider,
      displayName: account.displayName,
      settingsNs: DEFAULT_SETTINGS_NS,
      settingsPath: multiAccount(current()) ? ['accounts', provider] : [],
    }))

  /**
   * Registration facts: a change here must re-register the adapter routes.
   * Sorted like the directory entries for the same reason.
   */
  const registrationFacts = () => [...accounts().entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, account]) => ({ provider, retryPolicy: account.retryPolicy }))

  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let registeredDirectory: readonly unknown[] | undefined
  const ensureDirectory = (): void => {
    const entries = directoryEntries()
    if (deepEqualJson(entries, registeredDirectory)) return
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    registeredDirectory = entries
  }

  let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let registeredFacts: readonly unknown[] | undefined
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts()
    if (deepEqualJson(facts, registeredFacts)) return
    const routes = [...accounts().keys()].sort()
    if (registration === undefined) registration = ctx.llm.registerAdapter(routes, adapter)
    else registration.replace(routes)
    registeredFacts = facts
  }

  ensureDirectory()
  ensureRegistrationFacts()

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, DEFAULT_SETTINGS_NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        try {
          ensureRegistrationFacts()
        } catch (error: unknown) {
          ctx.logger.error('[commandcode-go-provider] keeping the previously registered routes after a refused update: %s', errorChain(error))
        }
        try {
          ensureDirectory()
        } catch (error: unknown) {
          ctx.logger.error('[commandcode-go-provider] keeping the previous configurable-provider directory after a refused update: %s', errorChain(error))
        }
      },
    })
  })

  /** Scan the Go catalog and swap it into the adapter's view. */
  async function sync(): Promise<void> {
    // The official CLI catalog owns the two facts the Provider API withholds:
    // which plan each model belongs to, and which reasoning efforts it takes.
    // Without it there is no honest Go filter, so a failed scan keeps the
    // previous catalog instead of guessing plan membership.
    const next = await fetchGoModels(await fetchCatalog())
    if (next.length === 0) {
      throw new Error('no Go models found; keeping the previous catalog')
    }
    if (deepEqualJson(next, scanned)) return
    scanned = next
    ctx.logger.info('[commandcode-go-provider] synced %d Go model(s): %s', next.length, next.map(m => m.id).join(', '))
  }

  void sync().catch((error: unknown) => {
    ctx.logger.warn('[commandcode-go-provider] initial scan failed: %s', errorChain(error))
  })
}
