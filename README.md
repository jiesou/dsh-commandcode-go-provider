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
    maxRequestImageBytes: 2097152
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"COMMANDCODE_API_KEY"` | 读取 API Key 的环境变量名（或 credential ref） |
| `baseURL` | `string` | `"https://api.commandcode.ai"` | Command Code 网关 base URL，`/alpha/generate` 自动追加 |
| `maxTokens` | `number` | `64000` | 单次请求输出 token 上限 |
| `defaultContextWindow` | `number` | `1000000` | 模型无精确 contextWindow 时的兜底值 |
| `maxRequestImageBytes` | `number` | `2097152`（2 MiB） | 单次请求允许内联的 base64 图片字节上限 |
| `accounts` | `object` | `{}` | 多账号字典：每个 key 是一个独立 provider 路由。缺省或空 = 单账号模式，直接使用顶层字段 |
| `http1` | `boolean` | `false` | 用 HTTP/1.1 发网关请求。Node ≥ 26 的 `fetch` 默认协商 HTTP/2 并把请求多路复用到一条连接上，网关边缘（Cloudflare）在高并发下会用 `ENHANCE_YOUR_CALM` 重置流；HTTP/1.1 把同一个限流变成可读的 429 |

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
| `maxRequestImageBytes` | `number` | 顶层 `maxRequestImageBytes` | 覆盖该账号的图片字节上限 |
| `retryPolicy` | `object` | 顶层 `retryPolicy` | 覆盖该账号的重试策略 |

模型目录只扫描一次、所有账号共享；改动设置后下个请求即生效，无需重启。把 `accounts` 清空或删掉即回到单账号模式。

Reasoning effort 不需要配置：档位来自官方 CLI catalog，模型只暴露它真正接受的档位（`low`/`medium`/`high`/`xhigh`/`max`），加一个显式 `Off` 入口。**Default** 表示"不发送 `reasoning_effort`"字段，由上游自行决定深度。**Off** 与 Default 的 wire 形态一致，但显式声明"不推理"的意图。catalog 里档位为空的模型干脆不显示档位选择器。

## 图片

`/alpha/generate` 是无状态的：网关不保存图片，也没有上传接口（官方 CLI 同样把整段历史里的图片每轮内联重发一次）。所以本插件按 DSH 的路由标准处理图片：

- 单张图片重编码到 1 MiB 以内（2048×2048 像素总预算）。
- 一轮请求内联的 base64 图片总量超过 `maxRequestImageBytes`（默认 2 MiB）时，不发请求，而是抛出 `IMAGE_OFFLOAD_REQUIRED` 并报出需要 offload 的张数。DSH 会据此把**最旧**的图片记入 `image/offload` 事件并重试；之后每轮都以占位文本代替这些图片的字节，模型仍能从占位文本里读到图片身份和可读路径。
- 已经 offload 的图片不再读取字节、不再编码、不再上传。

两个值都是 base64 口径（约等于原图字节 ×4/3）。默认组合约等于"一张整尺寸图 + 一张半尺寸图"：想更省流量就调小，想给模型更多图就调大。注意 `maxRequestImageBytes` 必须大于单张上限的 base64 长度（1 MiB 图约 1.4 MB），否则一张图也放不下。

## 兼容性

声明在 `package.json` 的 `dsh.compatibility`：DSH `>=0.1.7-alpha.1 <0.2.0`，Node.js `^22.19.0 || >=24.0.0`，Profile `web` / `headless`。

`>=0.1.7-alpha.1` 是硬下限，不是偏好：该版本起 dsh-llm 把工具结果改成独立的 `role: 'tool'` 消息（`toolCallId` 移到消息层），并重写了 dsh-settings 的表单模型（`installSection` 被 `SettingsForms` 取代、配置字段需标记 `volatile()` 才会出现在设置页）。本插件按新模型实现，0.1.6 及更早的 `role: 'user'` + `tool-result` block 形态不再支持。

逐版本证据（每个版本都用 `dsh plugin add <tarball>` 装进一次性 Profile，冷启动到发出真实请求，再卸载）：

| DSH 版本 | 安装 | 启动 | 卸载 |
| --- | --- | --- | --- |
| 0.1.7-rc.2 | 通过 | 通过 | 通过 |

0.1.7-alpha.1 / alpha.2 / rc.1 满足声明下限，但未逐版本实测。

复现方式：`DSH_HOME=<空目录> dsh --profile compat --from-default-profile headless`，装入对应版本的 `@deepseek-ai/dsh-base` / 依赖与插件 tarball，`dsh --profile compat --dump-config` 检查插件行，冷启动用真实网关请求校验 provider 与模型目录，最后 `dsh plugin --profile compat remove` 复查卸载后仍能启动。

## Credit

移植自 [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) 到 DSH。

本 plugin 加入了动态 reasoning effort 提取功能，从 <https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md> 解析。

## License

[MIT](LICENSE)
