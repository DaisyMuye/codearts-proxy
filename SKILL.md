---
name: codearts-proxy
description: "用华为云码道 CodeArts（免费 DeepSeek/GLM/Pangu 额度）作为 OpenAI 兼容模型源提供给 DSH 或任意客户端使用。适用于用户提到「码道」「CodeArts」「华为云免费模型」「devcloud 反代」「把网页版模型接进 DSH」「不想消耗自己 token」等场景，包含接口逆向结论、浏览器桥反代、tool calling 模拟层、DSH 路由配置与限流排障。"
license: MIT
user-invocable: true
tags: [proxy, openai-compatible, dsh, reverse-engineering]
metadata:
  version: "1.0.0"
---

# codearts-proxy

把华为云码道 CodeArts 的聊天后端包装成 OpenAI 兼容接口，供 DSH / Cherry Studio / NextChat 等客户端使用。整套流程是「浏览器桥 + 工具模拟」，因为服务端鉴权依赖页面会话，纯 HTTP 复现走不通。

## 何时使用

- 用户想把码道（`devcloud.cn-north-4.huaweicloud.com/chat`）的免费额度接到本地客户端
- 用户想在 DSH 里用免费模型而不消耗官方 API token
- 需要让这类**不支持 tool calling 的 agent 端点**表现得像带工具的模型

## AI 自主执行边界（AI 读到这段先看这里）

**第一件事：跑 `node assets/check.mjs`。** 它用退出码告诉你能不能继续：

| 退出码 | 含义 | 动作 |
|---|---|---|
| 0 | 全部就绪 | 直接 `node dsproxy.mjs`，然后配 DSH，全自动 |
| 2 | 有需人工介入的项 | 按输出里的 `→` 提示，向用户提出**唯一那一个**待办 |
| 1 | 环境错误 | 看报错修 |

### AI 能全自动完成的

- 部署 `dsproxy.mjs`、拉起进程、开机自启
- 写 DSH 的 `cordis.patch.yml` 与 `.credentials.yaml`
- 自动打开码道标签页（`Target.createTarget`）
- 逆向补齐缺失的请求头、调试 SSE 解析
- 端到端自检（`probe.mjs` 列模型、`testtool` 验工具调用）

### AI 做不了的两件事（不要浪费时间尝试）

1. **开启 Chrome 远程调试** —— 这是**死锁**：操作浏览器需要 CDP，但没开调试就连不上 CDP。AI 无法用代码勾选 `chrome://inspect` 那个 Allow 复选框。辅助办法只有「带 `--remote-debugging-port` 重启浏览器」，但那会另起 profile，**丢掉现有登录态**，等于把问题转移成问题 2。
2. **登录华为云** —— 账号密码、短信验证码、可能还有滑块，AI 不能代填，也不该索取。

### 所以正确的人机分工

```
人：一次性动作 —— 点 Allow 开调试 + 浏览器里登录码道
 ↓
AI：剩下全部 —— 检查、部署、配置、自检、排障
```

只要这两件事已经就绪，AI 可以**完全自主**跑完整个反代部署，中途不需要再问人。若 `check.mjs` 报「调试端口」或「登录态」失败，就**只向用户要那一件事**，不要反复重试。

## 前置条件

1. Chrome 已开启远程调试（`chrome://inspect/#remote-debugging` 勾选 Allow），且已登录华为云
2. Node 22+（依赖原生 WebSocket）
3. 码道聊天页保持打开（反代会自动拉起，但登录态必须有效）

## 一、接口事实（已逆向确认，直接复用）

Base：`https://devcloud.cn-north-4.huaweicloud.com`

| 用途 | 请求 |
|---|---|
| 新建会话 | `POST /chat/v1/cloudagent/sessions`，body `{"model_id":"..."}` |
| **发消息** | `POST /chat/codebaseservice/v1/cloudagent/sessions/{sid}/messages`，body `{"content":"...","model_id":"...","repos":[]}` |
| 会话列表 | `GET /chat/v1/cloudagent/sessions?page_num=1&page_size=20` |
| 历史消息 | `GET /chat/codebaseservice/v1/cloudagent/sessions/{sid}/messages?page_num=1&page_size=200` |
| 停止 | `POST /chat/v1/cloudagent/sessions/{sid}/messages/stop` |
| 模型列表 | `GET /chat/PromptCenterService/v1/model/builtin` |
| 排队状态 | `GET /chat/snap-manager/api/v1/queue/status?task_id={sid}&model={model}` |

**必需请求头**（少一个就 `TM.00001001`）：

```
content-type: application/json
x-requested-with: XMLHttpRequest
x-codearts-doer-scenario-type: web
Agent-Type: CodeBase          # 漏了报「请求头Agent-Type为空/非法」，取值不是猜测，前端常量 HI="CodeBase"
cftk: <cookie devclouddevuibjtcftk 的值>
```

**响应是 SSE**（`Accept: text/event-stream`），事件序列：

```
event: status          {"status":"initializing"|"processing"}
event: session_title   {"title":"..."}
event: thought         {"content":"...","part_id":"prt_xxx"}   ← 思考过程，不是正文
event: message         {"content":"...","part_id":"prt_xxx"}   ← 正文，⚠️ 增量，同 part_id 必须累加
event: file_diff       {"diff":[]}
event: step_finish     {"reason":"stop","tokens":{...},"cost":0}
event: done            {"latency_ms":...,"credit_cost_for_web":{...}}
```

⚠️ **最容易踩的坑**：`event: message` 是**逐片增量**。按 `part_id` 覆盖只剩最后一片，必须 `parts[pid] += content`。

## 二、为什么必须用浏览器桥

试过纯 curl，失败了两次：

1. `document.cookie` 只给 25 个非 HttpOnly cookie，缺会话凭据 → 返回 200 但空 body
2. 补全请求头后仍空 → 华为云 WAF（`HWWAFSESID`）盯 TLS 指纹

所以正确路线是：本地服务 → CDP 连 Chrome → 在**已登录页面里**发 fetch → 浏览器自动带齐 cookie/WAF 指纹。

## 三、部署

```bash
mkdir -p E:/REA && cd E:/REA
# 从 assets 复制实现
cp <skill>/assets/dsproxy.mjs .
node dsproxy.mjs
```

服务起在 `http://127.0.0.1:8787/v1`，API Key 随便填（不校验）。

**开机自启**：往 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` 放一个 vbs：

```vbs
Set s = CreateObject("WScript.Shell")
s.CurrentDirectory = "E:\REA"
s.Run """E:\Nodejs\node.exe"" ""E:\REA\dsproxy.mjs""", 0, False
```

## 四、接入 DSH

先确认当前跑的是哪个 profile —— **改错 profile 是最常见的失败原因**：

```bash
powershell -c "Get-CimInstance Win32_Process | ? {$_.CommandLine -like '*dsh*'} | % CommandLine"
# 看命令行里的 profiles\<名字>\，desktop 和 web 是两个不同的配置根
```

在 `~/.dsh/profiles/<实际profile>/cordis.patch.yml` 追加（`llm-pi-ai` 在 base bundle 里已是休眠挂载，用 `id` 覆盖它的 config，**不要 insert 新实例**）：

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

密钥引用写进 `~/.dsh/.credentials.yaml` 的 `refs:`：

```yaml
refs:
  CODEARTS_KEY: sk-local
```

**生效条件**：只有带 `patchReload: live` 的 profile 会热加载，否则必须重启 DSH。

## 五、工具调用模拟（关键）

码道是 agent 端点，**不认 OpenAI 的 `tools` 字段**，直接接进去只能聊天、不能干活。做法是在提示词层模拟：

**请求方向**：把 `tools` 压成紧凑文本（只留 `name(参数名:类型)`: 描述前 120 字），要求模型用固定标签输出：

```
<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>
```

**响应方向**：流式状态机边出文本边识别标签，标签本身不吐给客户端，解析成标准 `tool_calls` delta：

```json
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]},"finish_reason":null}]}
```

结束时 `finish_reason` 必须是 `tool_calls`（不是 `stop`），否则客户端不会执行工具。

实现细节在 `assets/dsproxy.mjs` 的 `buildToolPreamble` / `extractToolCalls` / `feed()`。文本模式要保留 `TOOL_OPEN.length - 1` 个字符的尾巴不吐，防止标签被 chunk 切断。

## 六、性能事实（别过度优化）

实测数字，桥接层不是瓶颈：

| 环节 | 耗时 |
|---|---|
| 响应头（桥接开销） | 34-40ms |
| 首字 | 3900-5800ms |
| 生成速度 | 24 字/秒 |

首字慢是 agent 架构决定的：每次请求都要过 26k token 的 agent system prompt，还要先跑完 `thought` 阶段。

有效的优化只有几条：

- **去掉轮询**：用 `Runtime.addBinding` 让页面直接 `__dsPush()` 推增量，比 40ms 轮询 + 全量序列化省 100-300ms
- **砍 prompt**：`MAX_PROMPT_CHARS=6000` 截历史，`DROP_SYSTEM=1` 直接丢 system（DSH 系统提示很长，对 agent 端点是纯噪音）
- ~~复用会话~~：只省 1.4 秒，且会串上下文，不建议
- ~~换 speed 模型~~：`speed` 模式反而更慢（19 字/秒）

## 七、排障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `TM.00001001 请求头Agent-Type为空/非法` | 缺 `Agent-Type: CodeBase` | 补头，值只能是 `CodeBase` |
| HTTP 200 但 body 空 | 缺 HttpOnly 会话 cookie / WAF 拦 TLS 指纹 | 改浏览器桥，别硬刚 curl |
| **`429 CODEBASE.00014000.429 Insufficient environmental resources`** | 推理资源池耗尽，新建会话仍 200 但发消息被拒 | 反代已内置 2 次退避重试；仍失败就冷却 10-30 分钟并降低请求频率 |
| `Session with given id not found` | 页面刷新导致 CDP pageSession 失效 | 重连 CDP 重 attach（已内置自动重试） |
| `上游返回空响应` | 上游给了空 SSE 流（限流的一种表现） | 同 429 处理 |
| 只出最后几个字 | 把 `message` 事件当全量覆盖了 | 按 part_id 累加 |
| 工具不执行 | `finish_reason` 给了 `stop` | 有 tool_calls 时必须给 `tool_calls` |
| DSH 里看不到模型 | 改错了 profile / profile 不支持热加载 | 核对进程命令行里的 profile 名，然后重启 |

### 429 的正确应对

`CODEBASE.00014000.429` 是资源池级限流，**新建会话接口不受影响**（永远返回 200），只有 `messages` 被拒。所以看到「会话建得出来、就是没有回复」基本就是它。

这会直接打死 agent 场景：DSH 一轮任务要连续调好几次模型，429 打断任何一步都会让整条链断掉。缓解手段只有降频、拉长 `IDLE_TIMEOUT`、或等冷却。

## 八、模型与成本

`GET /chat/PromptCenterService/v1/model/builtin` 返回 12 个，常用的：

`deepseek-v4.1-flash-1017`、`deepseek-v4.1-flash`、`glm-5.3-flash`、`openpangu-2.0-flash`、`kimi-k3`、`speed`（智速模式）

单轮短问答 `credit_cost` 约 0.16，`done` 事件会带 `total_token_used` 和 `cache_hit_ratio`。注意 agent 端点即使问 30 字也会吃 27k 上下文（`system_prompts: 26651`），长对话或并发会很烧额度、也更容易触发限流。

## 九、移植性（发给别人时看这段）

**能直接搬走的部分**：`SKILL.md` 全部知识（接口表、请求头、SSE 语义、坑、错误码），`assets/dsproxy.mjs` 全文。

**代码侧无需改动**：Chrome 数据目录已跨平台自动探测（Windows Chrome/Edge、macOS、Linux Chrome/Chromium/Edge），可用 `CHROME_DIR` 覆盖；端口从 `DevToolsActivePort` 动态读取，不写死；`start.bat` 用 `%~dp0` 和 `node`，不含绝对路径。

**搬不过去的三样东西**（对方必须自己具备）：

1. **华为云账号 + 码道登录态** —— 这是整套方案的鉴权本体，登录在浏览器 cookie 里，没法打包
2. **Chrome 远程调试开关** —— 对方要在 `chrome://inspect/#remote-debugging` 手动勾选 Allow，或带 `--remote-debugging-port=9222` 启动
3. **额度** —— 用的是谁的账号就扣谁的积分，且受同样的 429 资源池限制

**对方第一次跑的顺序**：

```bash
# 1. 确认 Node 22+
node -v

# 2. 在 Chrome 里登录码道，发送一条消息确认能用

# 3. 开远程调试（chrome://inspect/#remote-debugging 勾 Allow）

# 4. 启动
node dsproxy.mjs

# 5. 自检
curl http://127.0.0.1:8787/v1/models
node probe.mjs        # 能列出模型说明整条链路通了
```

**跨平台差异**：开机自启只有 Windows 的 vbs 写法，macOS 用 `launchd`、Linux 用 `systemd --user`，但那只是让进程常驻，和反代逻辑无关。

## 十、脚本清单

| 文件 | 用途 |
|---|---|
| `assets/check.mjs` | **部署前置自检**，退出码 0/2/1 表态，AI 靠它判断能否继续 |
| `assets/dsproxy.mjs` | 反代主体（浏览器桥 + tools 模拟 + SSE 转换） |
| `assets/start.bat` | Windows 前台启动 |
| `assets/probe.mjs` | 探查页面内可用接口与模型列表（调试用） |
