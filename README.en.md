<h1 align="center">dsh-commandcode-go-provider</h1>

<p align="center">
Bring Command Code Go / GOAT / Pro Plan subscriptions into DSH, with an auto-syncing model list. Plug in and go.
</p>

[简体中文](README.md)

Command Code subscriptions come in two flavors:

1. **Provider API**: standard OpenAI-compatible endpoints that plug into any agent harness directly, no third-party plugin needed.
2. **Go / GOAT / Pro Plan**: calling the Provider API returns `403 upgrade_required`; these plans can only be used through Command Code's private CLI gateway `/alpha/generate` (vendor lock-in).

This plugin solves the second case: it streams over `/alpha/generate` through DSH's native `LlmAdapter`, letting Go / GOAT / Pro Plan users use their subscribed models directly inside DSH. Models are **never hardcoded** — the plugin periodically fetches the live catalog from `/provider/v1/models` and merges each model's Reasoning Effort support from the official CLI catalog (CDN).

## Install

From npm (prebuilt, recommended):

```sh
dsh plugin --profile <name> add dsh-commandcode-go-provider
```

Or from GitHub (zero-build, artifacts are committed):

```sh
dsh plugin --profile <name> add github:jiesou/dsh-commandcode-go-provider
```

Or add a row to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: commandcode-go
      name: dsh-commandcode-go-provider
```

## After installing

Configure your API key, either way:

- Via environment variable:

```sh
export COMMANDCODE_API_KEY="your-command-code-api-key"
```

- Or store it through DSH's credentials service (written by the web Models page).

No model config is needed — on startup the plugin syncs the models included in your Go plan from `/provider/v1/models`, and merges per-model Reasoning Effort support from the official CLI catalog (CDN). After install, just pick the Command Code Go provider and a model in the web Models page.

### Configuration

All fields optional, defaults work out of the box:

```yaml
- id: commandcode-go
  name: dsh-commandcode-go-provider
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
    baseURL: https://api.commandcode.ai
    reasoningEffort: high
    maxTokens: 64000
    defaultContextWindow: 1000000
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | Env var name (or credential ref) holding the API key |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Command Code gateway base URL; `/alpha/generate` is appended |
| `reasoningEffort` | `string` | `undefined` | Default reasoning depth (`off` / `high` / `max`); explicit request values win |
| `maxTokens` | `number` | `64000` | Per-request output token cap |
| `defaultContextWindow` | `number` | `1000000` | Fallback context capacity when a model has no exact value |
| `streamIdleTimeoutMs` | `number` | `300000` | Max idle timeout while one stream read is outstanding (ms) |

## Credit

Port of [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) to DSH.

## License

[MIT](LICENSE)
