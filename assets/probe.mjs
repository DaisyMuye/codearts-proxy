// probe.mjs — 码道接口探针（调试用）
// 用法：node probe.mjs            列出模型
//       node probe.mjs <JS文件>   在码道页面里执行任意脚本并打印结果
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const candidates = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data'),
  path.join(home, 'Library/Application Support/Google/Chrome'),
  path.join(home, '.config/google-chrome'),
  path.join(home, '.config/chromium'),
].filter(Boolean);
const dir = process.env.CHROME_DIR || candidates.find(d => {
  try { return fs.existsSync(path.join(d, 'DevToolsActivePort')); } catch { return false; }
}) || candidates[0];
const [port, wsPath] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${Number(port)}${wsPath.trim()}`);
let mid = 0; const pending = new Map();

const send = (method, params = {}, sessionId) => {
  const id = ++mid;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const it = pending.get(m.id); pending.delete(m.id);
    m.error ? it.rej(new Error(m.error.message)) : it.res(m.result);
  }
});

const DEFAULT = `(async()=>{
  const cftk=(document.cookie.split("; ").find(c=>c.startsWith("devclouddevuibjtcftk="))||"").split("=")[1]||"";
  const H={"content-type":"application/json","x-requested-with":"XMLHttpRequest","x-codearts-doer-scenario-type":"web","Agent-Type":"CodeBase","accept":"application/json","cftk":cftk};
  const r=await fetch("/chat/PromptCenterService/v1/model/builtin",{headers:H});
  const j=await r.json();
  return j.builtinModels.map(m=>m.model_id+" | "+m.model_name+" | "+(m.model_desc||"").slice(0,24)).join("\\n");
})()`;

ws.addEventListener('open', async () => {
  try {
    const expr = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : DEFAULT;
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(t => t.type === 'page' && /devcloud\.cn-north-4\.huaweicloud\.com\/chat/.test(t.url));
    if (!page) { console.error('没找到码道页面，先在 Chrome 里打开并登录'); process.exit(1); }
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) { console.error('页面异常:', r.exceptionDetails.exception?.description); process.exit(1); }
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));
    process.exit(0);
  } catch (e) { console.error('ERR', e.message); process.exit(1); }
});
ws.addEventListener('error', e => { console.error('WS ERR', e.message); process.exit(2); });
