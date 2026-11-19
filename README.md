# codearts-proxy

把**华为云码道 CodeArts** 的聊天后端包装成 OpenAI 兼容接口，供 DSH / Cherry Studio / NextChat / LobeChat 等任意客户端使用。

附带一个 **tool calling 模拟层**，让这个原本只会聊天的 agent 端点能真正调用工具（bash、读写文件等），从而被 agent 框架当作可用模型驱动。

> 纯逆向 + 浏览器桥实现。不是官方 SDK，不保证长期可用。

## 它解决什么问题

码道网页版提供免费的 DeepSeek / GLM / Pangu 额度，但它是网页应用：

- 没有公开 API
- 鉴权绑在浏览器会话里（HttpOnly cookie + WAF 指纹）
- 接口是私有 SSE 协议，字段语义和 OpenAI 完全不同
- **是 agent 端点，不认 `tools` 参数**

本项目把这四点全部抹平，对外只暴露标准的 `/v1/chat/completions`。

## 特性

| | |
|---|---|
| OpenAI 兼容 | `/v1/models`、`/v1/chat/completions`，支持流式与非流式 |
| 浏览器桥鉴权 | 通过 CDP 在已登录页面里发请求，自动携带 cookie 与 WAF 指纹，无需处理 token 过期 |
| **Tool calling 模拟** | 工具定义压成提示词，模型用 `<tool_call>` 标签输出，反代解析回标准 `tool_calls` |
| 429 退避重试 | 资源池限流自动重试 2 次 |
| 跨平台 | Windows / macOS / Linux 自动探测浏览器数据目录 |
| 自检脚本 | `check.mjs` 用退出码表态，人和 AI 都能判断能否开工 |

## 架构

```
OpenAI client (DSH / Cherry Studio)
        │  POST /v1/chat/completions
        ▼
   dsproxy.mjs  (127.0.0.1:8787)
        │  CDP WebSocket
        ▼
   Chrome ──► 已登录的码道页面
                 │  fetch → /chat/codebaseservice/v1/cloudagent/sessions/{sid}/messages
                 ▼
            华为云后端  ──SSE──►  页面
                 │
                 └─ Runtime.addBinding 推送增量 ──► dsproxy ──► 客户端
```

关键点：请求必须**在页面上下文里**发出，否则华为云 WAF 会拦。

## 快速开始

### 0. 前置（必须人工做一次）

1. 浏览器打开 `chrome://inspect/#remote-debugging`，勾选 **Allow remote debugging**
2. 在同一浏览器里登录 [码道](https://devcloud.cn-north-4.huaweicloud.com/chat/home)
3. Node.js 22+

> 这两步是硬门槛。开调试必须点那个复选框（AI 无法代点），登录涉及验证码（AI 无法代填）。

### 1. 自检

```bash
node assets/check.mjs
```

```
[✓] Node 版本       v24.15.0
[✓] Chrome 调试端口   3735 (User Data)
[✓] 码道页面          码道CodeArts
[✓] 登录态           cftk 有效
[✓] 模型接口          12 个模型可达
────────────────────────────────────────
结论：全部就绪，可全自动部署
```

退出码：`0` 就绪、`2` 需人工介入、`1` 环境错误。

### 2. 启动

```bash
node assets/dsproxy.mjs
```

```
dsproxy 已启动: http://127.0.0.1:8787/v1  (push 模式)
```

### 3. 接入客户端

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | `sk-local`（不校验，占位即可） |
| Model | `deepseek-v4.1-flash-1017` |

### 4. 验证

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-1017","stream":true,
       "messages":[{"role":"user","content":"说三个字"}]}'
```

## 接入 DSH

DSH 用 `llm-pi-ai` 插件接自定义网关。**先确认实际运行的 profile**，改错 profile 是最常见的失败原因：

```bash
powershell -c "Get-CimInstance Win32_Process | ? {$_.CommandLine -like '*dsh*'} | % CommandLine"
```

在 `~/.dsh/profiles/<实际profile>/cordis.patch.yml` 追加（完整示例见 [`examples/dsh-patch.yml`](examples/dsh-patch.yml)）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      codearts:
        displayName: 码道 CodeArts
        apiKeyEnv: CODEARTS_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8787/v1
        defaultContextWindow: 262144
        defaultMaxTokens: 32768
        models:
          - id: deepseek-v4.1-flash-1017
            name: DeepSeek V4.1 Flash (码道)
            contextWindow: 262144
            maxTokens: 32768
            reasoningEfforts: false
```

凭据引用写入 `~/.dsh/.credentials.yaml`：

```yaml
refs:
  CODEARTS_KEY: sk-local
```

只有声明了 `patchReload: live` 的 profile 会热加载，否则需重启 DSH。

## Tool calling 是怎么模拟的

码道是 agent 端点，`tools` 字段会被直接忽略。这里在提示词层做桥：

**请求方向** —— 把 tools 压成紧凑清单注入提示词：

```
【工具调用协议 — 必须遵守】
你能通过工具操作本机。需要调用工具时，只输出下面这种标签：
<tool_call>{"name":"工具名","arguments":{参数JSON}}</tool_call>
可用工具：
- bash(command:string, description?:string): 在用户电脑上执行 shell 命令
- read(path:string): 读取文件内容
```

**响应方向** —— 流式状态机边出文本边识别标签，标签本身不吐给客户端：

```json
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function",
  "function":{"name":"bash","arguments":"{\"command\":\"ls -la\"}"}}]},"finish_reason":null}]}
```

结束时 `finish_reason` 必须是 `tool_calls` 而非 `stop`，否则客户端不会去执行。

实测：

```
耗时: 4189 ms
工具调用数: 1
  -> bash {"command":"ls -la","description":"列出当前目录文件"}
```

> **代价**：模型看到的是压缩后的工具描述（名称 + 参数名 + 描述前 120 字），不是完整 JSON Schema。参数简单的工具够用，结构复杂的可能填不准。

## 性能事实

别浪费时间优化桥，瓶颈不在那里：

| 环节 | 实测 |
|---|---|
| 响应头（桥接开销） | 34-40 ms |
| 首个 token | 3900-5800 ms |
| 生成速度 | 约 24 字/秒 |

首字慢由 agent 架构决定：每次请求都要过一遍 26k token 的 agent system prompt，还要先跑完思考阶段。

有效的优化只有：

- `MAX_PROMPT_CHARS=6000` 截断历史
- `DROP_SYSTEM=1` 丢弃系统提示（对 agent 端点是噪音）

## 已知限制

- **429 资源池限流**：`CODEBASE.00014000.429 Insufficient environmental resources`。新建会话永远返回 200，只有发消息被拒，表现成"会话建得出来、就是没回复"。agent 场景一轮要调多次模型，容易被打断。
- **依赖浏览器常开**：页面关掉反代就断（会自动重开，但要有登录态）。
- **不支持原生 tools**：模拟层是提示词级，模型可能不遵守格式。
- **接口随时可能变**：华为云改签名或收紧风控，本项目就需要重新逆向。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `TM.00001001 请求头Agent-Type为空` | 缺 `Agent-Type: CodeBase` | 补头 |
| HTTP 200 但 body 空 | 缺 HttpOnly cookie / WAF 拦指纹 | 必须用浏览器桥 |
| `Session with given id not found` | 页面刷新导致 CDP session 失效 | 已内置自动重连 |
| `429 CODEBASE.00014000.429` | 推理资源池耗尽 | 已内置退避重试，仍失败需冷却 |
| 只出最后几个字 | 把增量 `message` 事件当全量覆盖 | 按 `part_id` 累加 |
| 工具不执行 | `finish_reason` 给了 `stop` | 有 tool_calls 时给 `tool_calls` |

## 作为 Agent Skill 使用

`SKILL.md` 是可被 agent 框架加载的技能定义（含接口逆向结论、坑、错误码、AI 自主执行边界）。放进 `~/.agents/skills/` 或等价目录，AI 读到后能自行完成部署。

## 免责

仅供学习与个人使用。使用本项目意味着你复用自己账号的访问凭据，请自行遵守服务方条款。作者不对账号风险、服务变更或任何衍生后果负责。

## License

MIT
