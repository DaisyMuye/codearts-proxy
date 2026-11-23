# codearts-proxy

把**华为云码道 CodeArts** 的免费模型额度包装成 OpenAI 兼容接口，供 DSH / Cherry Studio / NextChat / LobeChat 等客户端使用。

纯 HTTP + AK/SK 签名实现。**不需要开浏览器，不需要开 IDE，密钥永不过期。**

> 非官方 SDK。接口为逆向所得，不保证长期可用。

## 它解决什么问题

码道提供免费的 DeepSeek / GLM / Kimi / Pangu 额度，但只有网页版和 IDE 版：

- 没有公开 API
- 网页版鉴权绑在浏览器会话里（HttpOnly cookie + WAF 指纹）
- IDE 版用临时 AK/SK + STS，24 小时过期，续期依赖 IDE 进程
- 都不是 OpenAI 格式

本项目直接对接底层网关，用**永久 AK/SK 签名**，对客户端只暴露标准 `/v1/chat/completions`。

## 特性

| | |
|---|---|
| OpenAI 兼容 | `/v1/models`、`/v1/chat/completions`，流式与非流式 |
| 永久密钥 | 华为云访问密钥，不依赖 IDE / 浏览器 / STS 续期 |
| 多账号池 | 多个账号按空闲窗口轮询（注意：同账号多 AK 共享额度，见下文） |
| 会话配额管理 | 上游限制 3 会话/60秒，自动排队 + 非流式降级 |
| 无第三方依赖 | 纯 Python 标准库 |

## 快速开始

### 1. 拿一个访问密钥

华为云控制台 → 我的凭证 → 访问密钥 → 新增，下载 CSV：

```
https://console.huaweicloud.com/iam/#/mine/accessKey
```

CSV 内容形如：

```csv
User Name,Access Key Id,Secret Access Key
"your-account","AKIDEXAMPLE0000000","SKEXAMPLE000000000000000000000000"
```

### 2. 配置

```bash
cp assets/codearts-aksk.json.example codearts-aksk.json
# 填入你的 AK/SK
```

单账号：

```json
{"access_key_id":"AKID...","secret_access_key":"SK..."}
```

多账号：

```json
{"accounts":[
  {"access_key_id":"AKID1","secret_access_key":"SK1"},
  {"access_key_id":"AKID2","secret_access_key":"SK2"}
]}
```

### 3. 启动

```bash
python assets/codearts-proxy-aksk.py
```

```
codearts-proxy-aksk listening on 127.0.0.1:18000
```

### 4. 验证

```bash
curl http://127.0.0.1:18000/healthz
python assets/verify_ak.py <AK> <SK>      # 验证某个密钥是否有效
python assets/t.py deepseek-v4.1-flash-1017 "说三个字"   # 测模型
```

### 5. 接入客户端

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:18000/v1` |
| API Key | 你设的 `LOCAL_API_KEY`（默认 `sk-local`，只保护本地代理） |
| 模型 | 见下方列表 |

## 可用模型

实测通过：

- `deepseek-v4.1-flash-1017`
- `glm-5.3-flash`
- `kimi-k3`
- `openpangu-2.0-flash`

完整清单见 `assets/snap_models.json`（11 个）。

## 接入 DSH

见 [`examples/dsh-patch.yml`](examples/dsh-patch.yml)。要点：

1. 先确认实际运行的 profile（`desktop` 还是 `web`），改错了不生效
2. `llm-pi-ai` 在 base bundle 里已是休眠挂载，用相同 `id` 覆盖 config
3. 凭据写进 `~/.dsh/.credentials.yaml` 的 `refs:`

## 接口细节（逆向结论）

上游端点：

```
POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
```

⚠️ 不是 `/snap-manager/...`，那前缀全是辅助接口。

签名（SDK-HMAC-SHA256）三个致命细节：

```python
canon_uri = u.path if u.path.endswith('/') else u.path + '/'   # ① 路径必须补尾斜杠
sdk_date  = now.strftime('%Y%m%dT%H%M%SZ')                     # ② 秒级 UTC，无毫秒
# ③ STS（临时凭据）只放 header 发送，绝不参与签名
```

`SignedHeaders` 只含 `content-type;host;x-sdk-date`。

## 会话限制（最容易踩的坑）

```
每个账号：最多 3 个存活会话
会话 = 在途请求 + 响应结束后约 60 秒残留
```

同一秒发 3 个短请求就把账号占满，第 4 个报：

```
TM.00001041  并发会话数已达上限(3个)
```

应对：

- 反代在无槽时自动降级为**非流式**（非流式不计入会话限制，实测 6 并发全 200），再转 SSE 返回
- `PROXY_MAX_PER_WINDOW=2` 给其他客户端留一个槽
- 排队长了返回 HTTP 429 + `Retry-After`，不静默挂起

### ⚠️ 同一账号的多个 AK 不增加额度

实测：两个 AK 来自同一 `User Name`，并发 6 个请求仍只成功 3 个。

上游按**账号**限流，不是按 AK。想真正提升上限只能换不同账号。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `LOCAL_API_KEY` | — | 客户端认证密钥（只保护本地代理） |
| `PROXY_PORT` | `18000` | 监听端口 |
| `PROXY_WINDOW_SECONDS` | `60` | 响应结束后的残留计时 |
| `PROXY_MAX_PER_WINDOW` | `3` | 每账号最大存活会话 |
| `PROXY_MAX_PER_SESSION` | `1` | 单会话最大在途请求 |
| `PROXY_MAX_WAIT_SECONDS` | `120` | 排队上限，超时返回 429 |
| `PROXY_NONSTREAM_FALLBACK` | `1` | 无槽时降级非流式 |
| `PROXY_NONSTREAM_TIMEOUT` | `45` | 非流式尝试上限（网关约 54-61s 会 504） |

## 已知限制

- **客户端请用 `stream: true`** —— 上游对非流式也返回 SSE 且先吐 `reasoning_content`，简单合并会丢正文
- **上下文长度**以实际可用为准，配置里写的 `1048576` 是模型标称值
- 接口随时可能变，华为云改签名或收紧风控需要重新逆向
- 免费额度有并发限制，不适合高并发场景

## 免责

仅供学习与个人使用。使用本项目意味着你用自己的账号凭据访问服务，请自行遵守服务方条款。作者不对账号风险、服务变更或衍生后果负责。

## License

MIT。反代主体源自 [kdczyz/codearts-proxy-aksk](https://github.com/kdczyz/codearts-proxy-aksk)，本地补了 STS 支持与多账号验证。
