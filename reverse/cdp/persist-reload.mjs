// 1) 开 popup 标签 → 写 storage 配置 → reload 扩展 → 关标签
// 2) 刷 cs 页 → 等插件 boot → 校验最终状态（不再手动 applyConfig，验证持久化链路）
const PORT = process.env.PORT || 9223;
const EXT_ID = 'pioohlmbendoaaoegkgfdbmdddfnnadd';
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => { bws.onopen = r; });
let mid = 0; const pending = new Map();
bws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const bsend = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);bws.send(JSON.stringify({id,method:m,params:p}));});
const { result: { targetId } } = await bsend('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup/popup.html`, background: true });
await new Promise(r => setTimeout(r, 1800));
const { result: { sessionId } } = await bsend('Target.attachToTarget', { targetId, flatten: true });
const ssend = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);bws.send(JSON.stringify({id,method:m,params:p,sessionId}));});
const w = await ssend('Runtime.evaluate', { expression: `
  chrome.storage.local.set({
    enabled: true, autoSend: true, provider: 'placeholder',
    minIntervalMs: 15000, maxRepliesPerConv: 1, dailyLimit: 200
  }).then(() => 'stored')`, awaitPromise: true, returnByValue: true });
console.log('storage:', w.result?.result?.value);
await ssend('Runtime.evaluate', { expression: 'chrome.runtime.reload()' });
console.log('extension reloaded');
await new Promise(r => setTimeout(r, 2500));
await bsend('Target.closeTarget', { targetId }).catch(()=>{});
bws.close();

// 刷页面
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
mid = 0; pending.clear();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description?.slice(0,300) } : r.result?.result?.value;
};
await new Promise(r => { ws.onopen = r; });
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
let ok = false;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const v = await evalJs('!!(window.__agent && window.__storeBridge && window.__storeBridge.getChatStore())');
  if (v === true) { ok = true; break; }
}
if (!ok) { console.log('PAGE_NOT_READY'); process.exit(1); }
// 等 host boot + host-bridge 配置下发（t=0/1.5s/4s 三次）全部落地
await new Promise(r => setTimeout(r, 7000));
const st = await evalJs(`(() => { const s = window.__agent.getState(); return { enabled: s.enabled, autoSend: s.autoSend, provider: s.provider, maxPerTurn: s.maxRepliesPerConv, minInterval: s.minIntervalMs, listening: !!s.unsubscribe, bootAtSet: s.bootAt > 0 }; })()`);
console.log('final state:', JSON.stringify(st));
process.exit(0);
