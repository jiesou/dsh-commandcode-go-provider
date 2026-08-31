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
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | Env var name (or credential ref) holding the API key |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Command Code gateway base URL; `/alpha/generate` is appended |
| `maxTokens` | `number` | `64000` | Per-request output token cap |
| `defaultContextWindow` | `number` | `1000000` | Fallback context capacity when a model has no exact value |

Reasoning effort needs no configuration: levels come from the official CLI catalog, and a model exposes exactly the levels it accepts (`low`/`medium`/`high`/`xhigh`/`max`), plus an explicit `Off` entry. **Default** means "do not send `reasoning_effort`" — the gateway decides the depth. **Off** is the same wire shape as Default but pins the intent explicitly. A model the catalog leaves blank shows no level selector at all.

## Credit

Port of [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) to DSH.

This plugin adds dynamic reasoning effort extraction, parsed from <https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md>.

## License

[MIT](LICENSE)
