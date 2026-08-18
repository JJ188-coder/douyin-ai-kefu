// 在指定端口 chrome://extensions 上操作开发者模式/读取扩展列表
const PORT = process.env.PORT || 9223;
const expr = process.argv[2];
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.startsWith('chrome://extensions'));
  if (!page) { const req = await fetch(`http://127.0.0.1:${PORT}/json/new?chrome://extensions/`); const d = await req.json(); page = d; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pending = new Map();
  const send = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
  ws.onmessage = ev => { const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} };
  ws.onopen = async () => {
    await send('Page.enable'); await send('Runtime.enable');
    await new Promise(r=>setTimeout(r,800));
    const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
    if (r.result?.exceptionDetails) console.log('EXC:', r.result.exceptionDetails.exception?.description?.slice(0,800));
    else console.log(JSON.stringify(r.result?.result?.value ?? r.result?.result?.description)?.slice(0,3000));
    process.exit(0);
  };
  setTimeout(()=>{console.log('TIMEOUT');process.exit(2);},15000);
})();
