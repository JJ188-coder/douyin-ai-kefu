const PORT = process.env.PORT || 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
if (!page) { console.error('no cs page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
ws.onmessage = ev => { const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} };
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0,400) || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
ws.onopen = async () => {
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: false });
  // 等页面和插件 boot
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const v = await evalJs('!!(window.__storeBridge && window.__storeBridge.getChatStore() && window.__agent)');
    if (v === true) { ready = true; break; }
  }
  if (!ready) { console.log('NOT_READY'); process.exit(1); }
  // 重新应用配置：placeholder + autoSend + 每条消费者消息最多回1条
  const cfg = await evalJs(`
    window.__agent.applyConfig ? window.__agent.applyConfig({ provider: 'placeholder', autoSend: true, enabled: true, maxRepliesPerConv: 1 }) : null;
    window.__agent.enable ? window.__agent.enable({ provider: 'placeholder', autoSend: true }) : null;
    ({ enabled: window.__agent.getState().enabled, autoSend: window.__agent.getState().autoSend, provider: window.__agent.getState().provider })
  `);
  console.log(JSON.stringify(cfg));
  process.exit(0);
};
setTimeout(()=>{console.log('TIMEOUT');process.exit(2);},80000);
