# dsh-commandcode-go-provider

Command Code Go API provider for dsh.

[English](README.en.md)

Command Code 提供的订阅分两种：

1. **Provider API**：提供标准 OpenAI 兼容端点，可以直接接入任何 agent harness，不需要第三方插件。
2. **Go / GOAT / Pro Plan**：调用 Provider API 端点会返回 `403 upgrade_required`，只能通过 Command Code 私有的 CLI 网关 `/alpha/generate` 使用（vendor lock-in）。

本插件针对第二种情况：通过 `/alpha/generate` 流式接入 DSH 的原生 `LlmAdapter`，让 Go / GOAT / Pro Plan 用户直接在 DSH 中使用订阅的模型。模型列表不写死在代码里，插件在启动时从 `/provider/v1/models` 拉取实时目录，并按官方 CLI catalog (CDN) 的 `Min plan` 列筛选：

- 只保留 `Min plan` 为 **Go and above** 的模型（计划顺序 Go < GOAT < Pro < Max），Go 计划包含的 premium 例外（GPT-5.6 Luna、Grok 4.5、Muse Spark 1.2 Contributor）自然落在其中，无需维护品牌名单。
- 同一份 catalog 还提供每个模型支持的 Reasoning Effort 档位。

## 安装

从 npm 安装（预构建产物，推荐）：

```sh
dsh plugin --profile web add @jiesou/dsh-commandcode-go-provider
```

或从 GitHub 安装：

```sh
dsh plugin --profile web add github:jiesou/dsh-commandcode-go-provider
```

## 安装之后

Command Code 的 API Key 应写入 `~/.dsh/.credentials.yaml`：

```sh
echo 'COMMANDCODE_API_KEY: [your key, be like user_xxxx]' >> ~/.dsh/.credentials.yaml
```

模型列表 **无需任何配置** ，插件在启动时从 `/provider/v1/models` 同步你的 Go 计划包含的模型，并从官方 CLI catalog (CDN) 合并每个模型的 Reasoning Effort 支持。挂载时上游不可达也不挂——目录暂时为空、不会拖垮插件。装完后在 Web 的 Models 页面选择 Command Code Go provider 及模型即可开始对话。

### 配置项

全部可选，默认即可用：

```yaml
- id: commandcode-go-provider
  name: '@jiesou/dsh-commandcode-go-provider'
  config:
    apiKeyEnv: COMMANDCODE_API_KEY
    baseURL: https://api.commandcode.ai
    maxTokens: 64000
    defaultContextWindow: 1000000
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | 读取 API Key 的环境变量名（或 credential ref） |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Command Code 网关 base URL，`/alpha/generate` 自动追加 |
| `maxTokens` | `number` | `64000` | 单次请求输出 token 上限 |
| `defaultContextWindow` | `number` | `1000000` | 模型无精确 contextWindow 时的兜底值 |
| `accounts` | `object` | `{}` | 多账号字典：每个 key 是一个独立 provider 路由。缺省或空 = 单账号模式，直接使用顶层字段 |

### 多账号

`accounts` 字典把同一个 Go 计划的多个账号暴露成多个独立 provider（模型选择器里各占一项，各持各的 API Key）。每个账号字段缺省时回退到顶层同名字段，`displayName` 缺省用账号 key：

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

| 账号字段 | 类型 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `displayName` | `string` | 账号 key | 模型选择器里的显示名 |
| `apiKeyEnv` | `string` | 顶层 `apiKeyEnv` | 该账号的 credential ref，在 Web Models 页对应账号卡片里写入 |
| `baseURL` | `string` | 顶层 `baseURL` | 覆盖该账号的网关地址 |
| `maxTokens` | `number` | 顶层 `maxTokens` | 覆盖该账号的输出上限 |
| `defaultContextWindow` | `number` | 顶层 `defaultContextWindow` | 覆盖该账号的兜底容量 |
| `retryPolicy` | `object` | 顶层 `retryPolicy` | 覆盖该账号的重试策略 |

模型目录只扫描一次、所有账号共享；改动设置后下个请求即生效，无需重启。把 `accounts` 清空或删掉即回到单账号模式。

Reasoning effort 不需要配置：档位来自官方 CLI catalog，模型只暴露它真正接受的档位（`low`/`medium`/`high`/`xhigh`/`max`），加一个显式 `Off` 入口。**Default** 表示"不发送 `reasoning_effort`"字段，由上游自行决定深度。**Off** 与 Default 的 wire 形态一致，但显式声明"不推理"的意图。catalog 里档位为空的模型干脆不显示档位选择器。

## Credit

移植自 [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) 到 DSH。

本 plugin 加入了动态 reasoning effort 提取功能，从 <https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md> 解析。

## License

[MIT](LICENSE)
