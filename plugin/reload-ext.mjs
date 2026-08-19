// 重载扩展：开一个 popup 标签页（扩展页面有 chrome.runtime 权限）→ reload → 关标签 → 刷 cs 页 → 重配
const PORT = process.env.PORT || 9223;
const EXT_ID = 'pioohlmbendoaaoegkgfdbmdddfnnadd';
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => { bws.onopen = r; });
let mid = 0; const pending = new Map();
bws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const bsend = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);bws.send(JSON.stringify({id,method:m,params:p}));});

// 1) 开 popup 标签
const { result: { targetId } } = await bsend('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup/popup.html`, background: true });
await new Promise(r => setTimeout(r, 1500));
const { result: { sessionId } } = await bsend('Target.attachToTarget', { targetId, flatten: true });
const ssend = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);bws.send(JSON.stringify({id,method:m,params:p,sessionId}));});
await ssend('Runtime.evaluate', { expression: 'chrome.runtime.reload()' });
console.log('extension reloaded');
await new Promise(r => setTimeout(r, 2500));
await bsend('Target.closeTarget', { targetId }).catch(()=>{});
bws.close();

// 2) 刷 cs 页面
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
if (!page) { console.error('no cs page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
mid = 0; pending.clear();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0,300) || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
await new Promise(r => { ws.onopen = r; });
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
let ready = false;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const v = await evalJs('!!(window.__storeBridge && window.__storeBridge.getChatStore() && window.__agent && window.__llmEngine)');
  if (v === true) { ready = true; break; }
}
if (!ready) { console.log('PAGE_NOT_READY'); process.exit(1); }
// 3) 等 host-bridge 把 chrome.storage 的持久化配置推完（页面加载后 0/1.5/4s 三次幂等下发），只打印状态，绝不覆盖线上配置
await new Promise(r => setTimeout(r, 4500));
const cfg = await evalJs(`
  (() => { const s = window.__agent.getState();
    return { enabled: s.enabled, autoSend: s.autoSend, provider: s.provider, maxPerTurn: s.maxRepliesPerConv, bootAtSet: s.bootAt > 0, minInterval: s.minIntervalMs, profileTone: !!(s.profile && s.profile.tone) }; })()
`);
console.log(JSON.stringify(cfg));
process.exit(0);
