// 支持 PORT 环境变量的 eval（9223）
const PORT = process.env.PORT || 9222;
const expr = process.argv[2];
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
  if (!page) { console.error('no cs page on', PORT); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pending = new Map();
  const send = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
  ws.onmessage = ev => { const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} };
  ws.onopen = async () => {
    const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
    if (r.result?.exceptionDetails) console.log('EXC:', r.result.exceptionDetails.exception?.description?.slice(0,600)||r.result.exceptionDetails.text);
    else console.log(JSON.stringify(r.result?.result?.value ?? r.result?.result?.description).slice(0,2000));
    process.exit(0);
  };
  setTimeout(()=>{console.log('TIMEOUT');process.exit(2);},20000);
})();
