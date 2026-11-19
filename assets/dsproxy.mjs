// dsproxy.mjs — 华为云 码道CodeArts(DeepSeek) → OpenAI 兼容反代
// 依赖：Node 22+（原生 WebSocket）、Chrome 已开启远程调试、码道页面已登录
// 用法：node dsproxy.mjs      客户端 base_url = http://127.0.0.1:8787/v1
//
// 性能要点：页面通过 CDP Runtime.addBinding 直接把每个增量 token 推回本进程，
// 不轮询、不序列化全量文本，端到端只多一次本地 IPC 往返（<2ms）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT       = Number(process.env.PORT || 8787);
const MODEL      = process.env.DS_MODEL || 'deepseek-v4.1-flash-1017';
const PAGE_MATCH = process.env.PAGE_MATCH || 'devcloud.cn-north-4.huaweicloud.com/chat';
const PAGE_URL   = process.env.PAGE_URL || 'https://devcloud.cn-north-4.huaweicloud.com/chat/home';

/** 跨平台找开着远程调试的浏览器数据目录 */
function detectChromeDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data'),
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium'),
    path.join(home, '.config/microsoft-edge'),
  ].filter(Boolean);
  for (const d of candidates) {
    try { if (fs.existsSync(path.join(d, 'DevToolsActivePort'))) return d; } catch {}
  }
  return candidates[0];
}

const CHROME_DIR = process.env.CHROME_DIR || detectChromeDir();
const IDLE_TIMEOUT = Number(process.env.IDLE_TIMEOUT || 180000);
// 上游是单轮 agent 接口，prompt 越长首字越慢；超出预算就丢最旧的历史
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 6000);
const DROP_SYSTEM = process.env.DROP_SYSTEM === '1';

/* ---------------- CDP ---------------- */
function readActivePort() {
  const f = path.join(CHROME_DIR, 'DevToolsActivePort');
  const [p, wsPath] = fs.readFileSync(f, 'utf8').trim().split('\n');
  return { port: Number(p), wsPath: wsPath.trim() };
}

let cdp = null;
let connecting = null;

async function connectCDP() {
  if (cdp && cdp.ws.readyState === 1 && cdp.pageSession) return cdp;
  if (connecting) return connecting;
  connecting = (async () => {
    const { port, wsPath } = readActivePort();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    const state = { ws, mid: 0, pending: new Map(), pageSession: null };

    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', (e) => rej(new Error('CDP 连接失败: ' + (e.message || 'unknown'))), { once: true });
    });

    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id && state.pending.has(m.id)) {
        const p = state.pending.get(m.id); state.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        return;
      }
      // 页面主动推送的增量
      if (m.method === 'Runtime.bindingCalled' && m.params?.name === '__dsPush') {
        let p; try { p = JSON.parse(m.params.payload); } catch { return; }
        dispatch(p);
      }
    });
    ws.addEventListener('close', () => { cdp = null; });

    state.send = (method, params = {}, sessionId) => {
      const id = ++state.mid;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((res, rej) => state.pending.set(id, { res, rej }));
    };

    const { targetInfos } = await state.send('Target.getTargets');
    let page = targetInfos.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
    if (!page) {
      console.log('[cdp] 没找到码道页面，自动开一个…');
      const { targetId } = await state.send('Target.createTarget', { url: PAGE_URL, background: true });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        const { targetInfos: ti } = await state.send('Target.getTargets');
        page = ti.find(t => t.targetId === targetId);
        if (page && page.url.includes('devcloud')) break;
      }
      if (!page) throw new Error('自动打开码道页面失败');
    }
    const { sessionId } = await state.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    state.pageSession = sessionId;

    // 开推送通道
    await state.send('Runtime.enable', {}, sessionId).catch(() => {});
    await state.send('Runtime.addBinding', { name: '__dsPush' }, sessionId);

    cdp = state;
    console.log(`[cdp] 已挂到页面: ${page.title || page.url.slice(0, 50)}`);
    return state;
  })().finally(() => { connecting = null; });
  return connecting;
}

async function evalOnce(expr, awaitPromise) {
  const s = await connectCDP();
  const r = await s.send('Runtime.evaluate', {
    expression: expr, awaitPromise, returnByValue: true, userGesture: true,
  }, s.pageSession);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面执行异常');
  return r.result?.value;
}

async function evaluate(expr, awaitPromise = false) {
  try {
    return await evalOnce(expr, awaitPromise);
  } catch (e) {
    const msg = String(e.message || e);
    if (/Session with given id not found|No target|Target closed|detached/i.test(msg)) {
      console.warn('[cdp] 页面会话失效，重连…');
      try { cdp?.ws?.close(); } catch {}
      cdp = null;
      await new Promise(r => setTimeout(r, 200));
      return await evalOnce(expr, awaitPromise);
    }
    throw e;
  }
}

/* ---------------- 任务分发 ---------------- */
const jobs = new Map(); // id -> { onDelta, onDone, onError }

function dispatch(p) {
  const job = jobs.get(p.id);
  if (!job) return;
  if (p.d) job.onDelta(p.d);
  if (p.err) job.onError(p.err);
  if (p.done) job.onDone();
}

/* ---------------- 页面内采集器 ---------------- */
const INJECT = `
if(!window.__dsBridge || window.__dsBridge.__v !== 4){
  window.__dsBridge = {
    __v: 4,
    push(obj){ try{ window.__dsPush(JSON.stringify(obj)); }catch(e){} },
    async start(id, prompt, modelId){
      const H = {
        "content-type":"application/json",
        "x-requested-with":"XMLHttpRequest",
        "x-codearts-doer-scenario-type":"web",
        "Agent-Type":"CodeBase",
        "cftk": (document.cookie.split("; ").find(c=>c.startsWith("devclouddevuibjtcftk="))||"").split("=")[1] || ""
      };
      const push = (o) => this.push(Object.assign({id}, o));
      try{
        const cr = await fetch("/chat/v1/cloudagent/sessions", {method:"POST", headers:H, body:JSON.stringify({model_id:modelId})});
        const cj = await cr.json();
        if(!cj || cj.status !== "ok") throw new Error("新建会话失败: "+JSON.stringify(cj).slice(0,160));
        const sid = cj.result.session_id;
        const doFetch = () => fetch("/chat/codebaseservice/v1/cloudagent/sessions/"+sid+"/messages", {
          method:"POST",
          headers: Object.assign({}, H, {accept:"text/event-stream"}),
          body: JSON.stringify({content:prompt, model_id:modelId, repos:[]})
        });
        let r = await doFetch();
        let tries = 0;
        while(r.status === 429 && tries < 2){
          tries++;
          push({hint:"上游资源不足 429，第"+tries+"次重试"});
          await new Promise(s=>setTimeout(s, 2000*tries));
          r = await doFetch();
        }
        if(r.status === 429){
          const body = await r.text().catch(()=> "");
          const m = body.match(/"error_msg":"([^"]+)"/);
          throw new Error("上游限流 429: " + (m ? m[1] : body.slice(0,150)));
        }
        if(!r.body) throw new Error("上游无流式响应: HTTP "+r.status);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let acc = "";
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          acc += dec.decode(value, {stream:true});
          let i;
          while((i = acc.indexOf("\\n\\n")) >= 0){
            const block = acc.slice(0, i); acc = acc.slice(i+2);
            let ev = "", data = "";
            for(const line of block.split("\\n")){
              if(line.startsWith("event:")) ev = line.slice(6).trim();
              else if(line.startsWith("data:")) data += line.slice(5).trim();
            }
            if(!data) continue;
            let o; try{ o = JSON.parse(data); }catch(e){ continue; }
            if(ev === "message" && typeof o.content === "string"){
              if(o.content) push({d: o.content});
            } else if(ev === "error"){
              push({err: o.message || o.error_msg || JSON.stringify(o)});
            }
          }
        }
      }catch(e){
        push({err: String(e && e.message || e)});
      }
      push({done: true});
    }
  };
}
"ok";
`;

/* ---------------- 工具调用模拟 ----------------
 * 码道是 agent 端点，不认 OpenAI 的 tools 参数。
 * 这里把 tools 压成提示词，让模型用 <tool_call> 标签输出，
 * 再解析回标准 tool_calls，DSH 才能真正"操控电脑"。
 */
const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';

function briefSchema(schema) {
  if (!schema || typeof schema !== 'object') return '';
  const props = schema.properties || {};
  const req = new Set(schema.required || []);
  const parts = [];
  for (const [k, v] of Object.entries(props)) {
    const type = v?.type || (v?.enum ? 'enum' : 'any');
    const en = v?.enum ? `[${v.enum.join('|')}]` : '';
    parts.push(`${k}${req.has(k) ? '' : '?'}:${type}${en}`);
  }
  return parts.join(', ');
}

function buildToolPreamble(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const lines = [];
  for (const t of tools) {
    const f = t.function || t;
    if (!f?.name) continue;
    const desc = String(f.description || '').replace(/\s+/g, ' ').slice(0, 120);
    lines.push(`- ${f.name}(${briefSchema(f.parameters)}): ${desc}`);
  }
  return [
    '【工具调用协议 — 必须遵守】',
    '你能通过工具操作本机（读写文件、执行命令等）。需要调用工具时，只输出下面这种标签，不要输出任何其他文字：',
    `${TOOL_OPEN}{"name":"工具名","arguments":{参数JSON}}${TOOL_CLOSE}`,
    '可以在一轮里输出多个这样的标签。不需要工具时，直接用自然语言回答。',
    '禁止在标签外解释你要调用什么。禁止使用 markdown 代码块包裹标签。',
    '可用工具：',
    ...lines,
  ].join('\n');
}

function renderHistory(messages) {
  const out = [];
  for (const m of messages) {
    const who = m.role === 'user' ? '用户'
      : m.role === 'assistant' ? '助手'
      : m.role === 'tool' ? `工具结果${m.name ? `(${m.name})` : ''}`
      : m.role === 'system' ? '系统' : m.role;
    let text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : String(m.content ?? '');
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(c => `${TOOL_OPEN}${JSON.stringify({ name: c.function?.name, arguments: JSON.parse(c.function?.arguments || '{}') })}${TOOL_CLOSE}`).join('');
      text = (text ? text + '\n' : '') + calls;
    }
    if (text) out.push(`${who}：${text}`);
  }
  return out;
}

function flattenMessages(messages) {
  const sys = DROP_SYSTEM ? '' : messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const turn = messages.filter(m => m.role !== 'system');

  if (turn.length <= 1) {
    const last = [...turn].reverse().find(m => m.role === 'user');
    const raw = typeof last?.content === 'string' ? last.content
      : Array.isArray(last?.content) ? last.content.map(p => p.text || '').join('') : '';
    return raw.length > MAX_PROMPT_CHARS ? raw.slice(-MAX_PROMPT_CHARS) : raw;
  }

  const picked = [];
  let used = 0;
  for (let i = turn.length - 1; i >= 0; i--) {
    const line = renderHistory([turn[i]])[0] || '';
    if (!line) continue;
    if (used + line.length > MAX_PROMPT_CHARS && picked.length) break;
    picked.unshift(line);
    used += line.length + 2;
  }
  const head = sys ? `【系统设定】${sys.slice(0, 800)}\n\n` : '';
  return head + `【对话历史】\n${picked.join('\n\n')}\n\n请基于以上对话，回答最后一条用户消息。`;
}

/** 从模型输出里抽出 tool_call，返回 { text, calls } */
function extractToolCalls(s) {
  const calls = [];
  let text = '';
  let i = 0;
  while (true) {
    const start = s.indexOf(TOOL_OPEN, i);
    if (start < 0) { text += s.slice(i); break; }
    text += s.slice(i, start);
    const end = s.indexOf(TOOL_CLOSE, start);
    if (end < 0) { text += s.slice(start); break; }
    const raw = s.slice(start + TOOL_OPEN.length, end).trim();
    try {
      const o = JSON.parse(raw);
      if (o && o.name) {
        calls.push({ name: String(o.name), arguments: typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments ?? {}) });
      }
    } catch { text += s.slice(start, end + TOOL_CLOSE.length); }
    i = end + TOOL_CLOSE.length;
  }
  return { text: text.trim(), calls };
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(obj));
  };

  if (req.url.startsWith('/v1/models')) {
    return json(200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'huawei-codearts' }] });
  }
  if (!req.url.startsWith('/v1/chat/completions') || req.method !== 'POST')
    return json(404, { error: { message: 'use /v1/chat/completions' } });

  let raw = '';
  for await (const c of req) raw += c;
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return json(400, { error: { message: 'bad json' } }); }

  const stream = input.stream !== false;
  const modelId = (input.model && input.model !== 'ds-web') ? input.model : MODEL;
  const preamble = input.tool_choice === 'none' ? '' : buildToolPreamble(input.tools);
  const prompt = (preamble ? preamble + '\n\n' : '') + flattenMessages(input.messages || []);
  const cid = 'chatcmpl-' + Math.random().toString(36).slice(2);
  const jobId = cid.replace(/[^a-z0-9]/gi, '');
  const created = Math.floor(Date.now() / 1000);

  try {
    await evaluate(INJECT, false);
  } catch (e) {
    return json(502, { error: { message: '桥接失败: ' + (e.message || e) } });
  }

  const frame = (delta, finish = null) => `data: ${JSON.stringify({
    id: cid, object: 'chat.completion.chunk', created, model: modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

  if (!stream) {
    let text = '', err = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { jobs.delete(jobId); resolve(); }, IDLE_TIMEOUT);
      jobs.set(jobId, {
        onDelta: (d) => { text += d; },
        onError: (e) => { err = e; },
        onDone: () => { clearTimeout(timer); jobs.delete(jobId); resolve(); },
      });
      evaluate(`window.__dsBridge.start(${JSON.stringify(jobId)}, ${JSON.stringify(prompt)}, ${JSON.stringify(modelId)}), "go"`).catch(e => {
        err = String(e.message || e); clearTimeout(timer); jobs.delete(jobId); resolve();
      });
    });
    if (err) return json(502, { error: { message: err } });
    if (!text) return json(502, { error: { message: '上游返回空响应：码道当前可能在限流或排队，请稍后重试' } });
    const { text: clean, calls } = extractToolCalls(text);
    const msg = { role: 'assistant', content: clean || null };
    if (calls.length) {
      msg.tool_calls = calls.map((c, i) => ({
        id: 'call_' + Math.random().toString(36).slice(2, 10),
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    return json(200, {
      id: cid, object: 'chat.completion', created, model: modelId,
      choices: [{ index: 0, message: msg, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...cors,
  });
  res.write(frame({ role: 'assistant', content: '' }));

  let finished = false;
  let got = 0;
  let callIdx = 0;

  // 流式状态机：边出文本边识别 <tool_call>，标签本身不吐给客户端
  let sbuf = '', semit = 0;
  const flushText = (s) => { if (s) { res.write(frame({ content: s })); got += s.length; } };
  const emitCall = (name, args) => {
    res.write(`data: ${JSON.stringify({
      id: cid, object: 'chat.completion.chunk', created, model: modelId,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: callIdx++, id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: args } }] },
        finish_reason: null,
      }],
    })}\n\n`);
  };
  const feed = (d) => {
    sbuf += d;
    for (;;) {
      const start = sbuf.indexOf(TOOL_OPEN, semit);
      if (start < 0) {
        const safe = Math.max(semit, sbuf.length - (TOOL_OPEN.length - 1));
        if (safe > semit) { flushText(sbuf.slice(semit, safe)); semit = safe; }
        return;
      }
      if (start > semit) flushText(sbuf.slice(semit, start));
      const end = sbuf.indexOf(TOOL_CLOSE, start);
      if (end < 0) { semit = start; return; }
      const raw = sbuf.slice(start + TOOL_OPEN.length, end).trim();
      try {
        const o = JSON.parse(raw);
        if (o && o.name) emitCall(String(o.name), typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments ?? {}));
        else flushText(sbuf.slice(start, end + TOOL_CLOSE.length));
      } catch {
        flushText(sbuf.slice(start, end + TOOL_CLOSE.length));
      }
      semit = end + TOOL_CLOSE.length;
    }
  };

  await new Promise((resolve) => {
    const timer = setTimeout(() => { console.warn('[warn] 上游超时，强制收尾'); jobs.delete(jobId); resolve(); }, IDLE_TIMEOUT);
    jobs.set(jobId, {
      onDelta: (d) => { feed(d); },
      onError: (e) => { res.write(`data: ${JSON.stringify({ error: { message: e } })}\n\n`); },
      onDone: () => { finished = true; clearTimeout(timer); jobs.delete(jobId); resolve(); },
    });
    evaluate(`window.__dsBridge.start(${JSON.stringify(jobId)}, ${JSON.stringify(prompt)}, ${JSON.stringify(modelId)}), "go"`).catch(e => {
      res.write(`data: ${JSON.stringify({ error: { message: String(e.message || e) } })}\n\n`);
      clearTimeout(timer); jobs.delete(jobId); resolve();
    });
  });

  if (semit < sbuf.length) flushText(sbuf.slice(semit));
  semit = sbuf.length;

  if (finished && got === 0 && callIdx === 0) {
    res.write(`data: ${JSON.stringify({ error: { message: '上游返回空响应：码道当前可能在限流或排队，请稍后重试' } })}\n\n`);
  }

  res.write(frame({}, callIdx > 0 ? 'tool_calls' : 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
  if (!finished) console.warn('[warn] 未收到 done');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dsproxy 已启动: http://127.0.0.1:${PORT}/v1  (push 模式)`);
  console.log(`模型 ${MODEL}   页面匹配 ${PAGE_MATCH}`);
  connectCDP().catch(e => console.error('[cdp] 预连接失败:', e.message));
});
