# dsh-commandcode-go-provider

Command Code Go API provider for dsh.

[简体中文](README.md)

Command Code subscriptions come in two flavors:

1. **Provider API**: standard OpenAI-compatible endpoints that plug into any agent harness directly, no third-party plugin needed.
2. **Go / GOAT / Pro Plan**: calling the Provider API returns `403 upgrade_required`; these plans can only be used through Command Code's private CLI gateway `/alpha/generate` (vendor lock-in).

This plugin solves the second case: it streams over `/alpha/generate` through DSH's native `LlmAdapter`, letting Go / GOAT / Pro Plan users use their subscribed models directly inside DSH. Models are **never hardcoded** — on startup the plugin fetches the live catalog from `/provider/v1/models` and filters it by the `Min plan` column of the official CLI catalog (CDN):

- Only models whose `Min plan` is **Go and above** are kept (plans order Go < GOAT < Pro < Max), which already covers the premium models Go includes (GPT-5.6 Luna, Grok 4.5, Muse Spark 1.2 Contributor) with no brand list to maintain.
- The same catalog supplies each model's supported Reasoning Effort levels.

## Install

From npm (prebuilt, recommended):

```sh
dsh plugin --profile web add @jiesou/dsh-commandcode-go-provider
```

Or from GitHub:

```sh
dsh plugin --profile web add github:jiesou/dsh-commandcode-go-provider
```

Your Command Code API key should be written to `~/.dsh/.credentials.yaml`:

```sh
echo 'COMMANDCODE_API_KEY: [your key, be like user_xxxx]' >> ~/.dsh/.credentials.yaml
```

## After installing

Store your API key through DSH's credentials service (written by the web Models page).

No model config is needed — on startup the plugin syncs the models included in your Go plan from `/provider/v1/models`, and merges per-model Reasoning Effort support from the official CLI catalog (CDN). After install, just pick the Command Code Go provider and a model in the web Models page. If the upstream is unreachable at mount the plugin still comes up with an empty catalog — one network blip never takes the model surface down.

### Configuration

All fields optional, defaults work out of the box:

```yaml
- id: commandcode-go-provider
  name: '@jiesou/dsh-commandcode-go-provider'
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
    baseURL: https://api.commandcode.ai
    maxTokens: 64000
    defaultContextWindow: 1000000
    maxRequestImageBytes: 2097152
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | Env var name (or credential ref) holding the API key |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Command Code gateway base URL; `/alpha/generate` is appended |
| `maxTokens` | `number` | `64000` | Per-request output token cap |
| `defaultContextWindow` | `number` | `1000000` | Fallback context capacity when a model has no exact value |
| `maxRequestImageBytes` | `number` | `2097152` (2 MiB) | Inline base64 image budget for one request |
| `accounts` | `object` | `{}` | Multi-account dictionary: each key is an independent provider route. Absent or empty = single-account mode driven by the top-level fields |
| `http1` | `boolean` | `false` | Send gateway requests over HTTP/1.1. Node ≥ 26 negotiates HTTP/2 for `fetch` and multiplexes everything onto one connection; the gateway's edge (Cloudflare) resets streams with `ENHANCE_YOUR_CALM` under that concurrency. HTTP/1.1 turns the same limit into a readable 429 |

### Multiple accounts

The `accounts` dictionary exposes several accounts of the same Go plan as several independent providers (each gets its own entry in the model picker and holds its own API key). Every account field falls back to the top-level field of the same name; `displayName` defaults to the account key:

```yaml
- id: commandcode-go-provider
  name: '@jiesou/dsh-commandcode-go-provider'
  config:
    accounts:
      commandcode-1:
        displayName: Command Code Go 1
        apiKeyEnv: COMMANDCODE_API_KEY
      commandcode-2:
        displayName: Command Code Go 2
        apiKeyEnv: COMMANDCODE_API_KEY_2
    baseURL: https://api.commandcode.ai
    retryPolicy:
      mode: always
```

| Account field | Type | Default | Description |
| --- | --- | --- | --- |
| `displayName` | `string` | account key | Label shown in the model picker |
| `apiKeyEnv` | `string` | top-level `apiKeyEnv` | Credential ref for this account, written through its card on the web Models page |
| `baseURL` | `string` | top-level `baseURL` | Per-account gateway override |
| `maxTokens` | `number` | top-level `maxTokens` | Per-account output cap override |
| `defaultContextWindow` | `number` | top-level `defaultContextWindow` | Per-account fallback capacity override |
| `maxRequestImageBytes` | `number` | top-level `maxRequestImageBytes` | Per-account image budget override |
| `retryPolicy` | `object` | top-level `retryPolicy` | Per-account retry policy override |

The model catalog is scanned once and shared by every account; settings changes apply to the next request without a restart. Empty or remove `accounts` to go back to the single-account shape.

Reasoning effort needs no configuration: levels come from the official CLI catalog, and a model exposes exactly the levels it accepts (`low`/`medium`/`high`/`xhigh`/`max`), plus an explicit `Off` entry. **Default** means "do not send `reasoning_effort`" — the gateway decides the depth. **Off** is the same wire shape as Default but pins the intent explicitly. A model the catalog leaves blank shows no level selector at all.

## Images

`/alpha/generate` is stateless: the gateway stores no image and exposes no upload endpoint (the official CLI also re-sends every historical image inline on every turn). So this plugin follows the DSH route standard:

- Each image is re-encoded to fit 1 MiB (under a 2048×2048 pixel budget).
- When the inline base64 images of one request exceed `maxRequestImageBytes` (default 2 MiB), no request is sent; the adapter throws `IMAGE_OFFLOAD_REQUIRED` naming how many occurrences must be offloaded. DSH records the **oldest** ones in an `image/offload` event and retries; from then on their bytes are replaced by placeholder text that still names the image identity and a readable path.
- An offloaded image is never read, encoded, or uploaded again.

Both values count base64 characters (about 4/3 of the raw bytes). The default pair holds one full-size image plus one half-size image: lower them to save more bandwidth, raise them to keep more images visible to the model. Keep `maxRequestImageBytes` above one image's base64 length (a 1 MiB image is ~1.4 MB), or not even one image fits.

## Compatibility

Declared in `package.json` under `dsh.compatibility`: DSH `>=0.1.7-alpha.1 <0.2.0`, Node.js `^22.19.0 || >=24.0.0`, profiles `web` / `headless`.

`>=0.1.7-alpha.1` is a hard floor, not a preference: that release made dsh-llm carry tool results as first-class `role: 'tool'` messages (`toolCallId` moved to the message) and rewrote the dsh-settings form model (`installSection` replaced by `SettingsForms`, and a config field only appears on the settings page once it is marked `volatile()`). This plugin implements the new model; the pre-0.1.7 `role: 'user'` + `tool-result` block shape is no longer supported.

Per-release evidence (each release installed into a disposable profile with `dsh plugin add <tarball>`, cold-started until it issued a real request, then uninstalled):

| DSH version | install | start | uninstall |
| --- | --- | --- | --- |
| 0.1.7-rc.2 | passed | passed | passed |

0.1.7-alpha.1 / alpha.2 / rc.1 meet the declared floor but were not each verified end to end.

Reproduce with `DSH_HOME=<empty dir> dsh --profile compat --from-default-profile headless`, add that release's `@deepseek-ai/dsh-base` and the plugin tarball, check the plugin row in `dsh --profile compat --dump-config`, cold-start a real gateway request to exercise the provider and its model catalog, then `dsh plugin --profile compat remove` and confirm the profile still boots.

## Credit

Port of [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) to DSH.

This plugin adds dynamic reasoning effort extraction, parsed from <https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md>.

## License

[MIT](LICENSE)
