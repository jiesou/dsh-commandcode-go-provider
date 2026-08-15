# dsh-commandcode-go-provider

Command Code Go API provider for dsh.

[English](README.en.md)

Command Code 提供的订阅分两种：

1. **Provider API**：提供标准 OpenAI 兼容端点，可以直接接入任何 agent harness，不需要第三方插件。
2. **Go / GOAT / Pro Plan**：调用 Provider API 端点会返回 `403 upgrade_required`，只能通过 Command Code 私有的 CLI 网关 `/alpha/generate` 使用（vendor lock-in）。

本插件解决第二种情况：通过 `/alpha/generate` 流式接入 DSH 的原生 `LlmAdapter`，让 Go / GOAT / Pro Plan 用户直接在 DSH 中使用订阅的模型。模型列表不写死在代码里——插件会定时从 `/provider/v1/models` 拉取实时目录，并按 Go Plan 的成员规则筛选：

- **默认保留开源模型**（deepseek、Qwen、MiniMaxAI、xiaomi、stepfun、tencent、nvidia、moonshotai 等 provider）。
- **Hard-code 了几个 Go Plan 也包含的 premium model 例外**，如 GPT-5.6 Luna、Grok 4.5、Muse Spark 1.2 Contributor。
- 其余 premium 模型（Claude、Gemini、Grok 4.6 等）一律排除。

筛选后还会从官方 CLI catalog (CDN) 合并每个模型的 Reasoning Effort 支持。

## 安装

从 npm 安装（预构建产物，推荐）：

```sh
dsh plugin --profile <name> add @jiesou/dsh-commandcode-go-provider
```

或从 GitHub 安装（零构建，产物已入库）：

```sh
dsh plugin --profile <name> add github:jiesou/dsh-commandcode-go-provider
```

或者在你 profile 的 `cordis.patch.yml` 中添加一行：

```yaml
- insert:
    - id: commandcode-go
      name: '@jiesou/dsh-commandcode-go-provider'
```

Command Code 的 API Key 应写入 `~/.dsh/.credentials.yaml`：

```sh
echo 'COMMANDCODE_API_KEY: [your key, be like user_xxxx]' >> ~/.dsh/.credentials.yaml
```

## 安装之后

通过 DSH 的 credentials 服务保存 API Key（Web Models 设置页写入）。

模型列表无需任何配置——插件启动后会自动从 `/provider/v1/models` 同步你的 Go 计划包含的模型，并从官方 CLI catalog (CDN) 合并每个模型的 Reasoning Effort 支持。装完后在 Web 的 Models 页面选择 Command Code Go provider 及模型即可开始对话。

### 配置项

全部可选，默认即可用：

```yaml
- id: commandcode-go
  name: '@jiesou/dsh-commandcode-go-provider'
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
    baseURL: https://api.commandcode.ai
    reasoningEffort: high
    maxTokens: 64000
    defaultContextWindow: 1000000
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | 读取 API Key 的环境变量名（或 credential ref） |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Command Code 网关 base URL，`/alpha/generate` 自动追加 |
| `reasoningEffort` | `string` | `undefined` | 默认推理深度（`off` / `high` / `max`），调用方指定时优先 |
| `maxTokens` | `number` | `64000` | 单次请求输出 token 上限 |
| `defaultContextWindow` | `number` | `1000000` | 模型无精确 contextWindow 时的兜底值 |
| `streamIdleTimeoutMs` | `number` | `300000` | 单次流读取的最大空闲超时（毫秒） |

## Credit

移植自 [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) 到 DSH。

本 plugin 加入了动态 reasoning effort 提取功能，从 <https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md> 解析。

## License

[MIT](LICENSE)
