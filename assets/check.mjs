// check.mjs — 部署前置自检：告诉调用者（人或 AI）现在能不能继续，卡在哪一步
// 用法：node check.mjs
// 退出码：0=全部就绪  2=需人工介入  1=环境错误
import fs from 'node:fs';
import path from 'node:path';

const steps = [];
const ok = (n, d) => steps.push({ n, s: 'OK', d });
const bad = (n, d, fix) => steps.push({ n, s: 'FAIL', d, fix });

/* 1. Node */
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok('Node 版本', `v${process.versions.node}`);
else bad('Node 版本', `v${process.versions.node}（需要 22+，原生 WebSocket）`, '升级 Node 到 22 或更高');

/* 2. 浏览器数据目录 + 调试端口 */
const home = process.env.HOME || process.env.USERPROFILE || '';
const candidates = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data'),
  path.join(home, 'Library/Application Support/Google/Chrome'),
  path.join(home, '.config/google-chrome'),
  path.join(home, '.config/chromium'),
].filter(Boolean);

let chromeDir = process.env.CHROME_DIR || candidates.find(d => {
  try { return fs.existsSync(path.join(d, 'DevToolsActivePort')); } catch { return false; }
});

let wsUrl = null;
if (!chromeDir) {
  bad('Chrome 调试端口', '找不到 DevToolsActivePort，浏览器没开远程调试',
    '在浏览器地址栏打开 chrome://inspect/#remote-debugging 勾选 Allow，或用 --remote-debugging-port=9222 启动');
} else {
  try {
    const [p, wsPath] = fs.readFileSync(path.join(chromeDir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    wsUrl = `ws://127.0.0.1:${Number(p)}${wsPath.trim()}`;
    ok('Chrome 调试端口', `${p} (${path.basename(chromeDir)})`);
  } catch (e) {
    bad('Chrome 调试端口', 'DevToolsActivePort 读取失败', '重启浏览器并确认远程调试已开启');
  }
}

if (!wsUrl) {
  report();
} else {
  connectAndCheck(wsUrl);
}

function connectAndCheck(wsUrl) {
  const ws = new WebSocket(wsUrl);
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

  ws.addEventListener('error', () => { bad('CDP 连接', 'WebSocket 连不上调试端口', '确认浏览器还开着、端口没变'); report(); });

  ws.addEventListener('open', async () => {
    try {
      const { targetInfos } = await send('Target.getTargets');
      const page = targetInfos.find(t => t.type === 'page' && /devcloud\.cn-north-4\.huaweicloud\.com\/chat/.test(t.url));

      if (!page) {
        bad('码道页面', '没有已打开的码道标签页',
          'AI 可自动打开（dsproxy 会 Target.createTarget），但该标签页必须是登录状态');
      } else {
        ok('码道页面', page.title || page.url.slice(0, 50));
      }

      if (page) {
        const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        const r = await send('Runtime.evaluate', {
          awaitPromise: true, returnByValue: true,
          expression: `(async()=>{
            const c=(document.cookie.split("; ").find(x=>x.startsWith("devclouddevuibjtcftk="))||"").split("=")[1]||"";
            if(!c) return JSON.stringify({logged:false});
            const H={"content-type":"application/json","x-requested-with":"XMLHttpRequest","x-codearts-doer-scenario-type":"web","Agent-Type":"CodeBase","accept":"application/json","cftk":c};
            try{
              const r=await fetch("/chat/PromptCenterService/v1/model/builtin",{headers:H});
              const j=await r.json();
              return JSON.stringify({logged:true, count:(j.builtinModels||[]).length});
            }catch(e){ return JSON.stringify({logged:true, count:-1, err:String(e.message||e)}); }
          })()`,
        }, sessionId);
        let info; try { info = JSON.parse(r.result.value); } catch { info = { logged: false }; }

        if (!info.logged) bad('登录态', '拿不到 cftk cookie，未登录', '让用户在浏览器里登录华为云码道，然后重跑本检查');
        else ok('登录态', 'cftk 有效');

        if (info.count > 0) ok('模型接口', `${info.count} 个模型可达`);
        else if (info.logged) bad('模型接口', '接口不通或被拦', '检查网络/账号权限；400 带 TM.00001001 说明缺 Agent-Type 头');
      }
    } catch (e) {
      bad('CDP 检查', e.message, '重试，或重启浏览器后重新开启远程调试');
    }
    report();
  });
}

function report() {
  const w = Math.max(...steps.map(s => s.n.length)) + 2;
  console.log('\n=== 码道反代 部署前置检查 ===\n');
  for (const s of steps) {
    console.log(`${s.s === 'OK' ? '[✓]' : '[✗]'} ${s.n.padEnd(w)} ${s.d}`);
    if (s.fix) console.log(`${' '.repeat(w + 5)}→ ${s.fix}`);
  }
  const fails = steps.filter(s => s.s !== 'OK');
  console.log('\n' + '─'.repeat(60));
  if (!fails.length) {
    console.log('结论：全部就绪，可全自动部署（node dsproxy.mjs 即可）');
    process.exit(0);
  }
  console.log(`结论：${fails.length} 项待处理，其中需要人工介入的看 → 后面的提示`);
  process.exit(2);
}
