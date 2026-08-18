// 通过 popup 扩展页面重载扩展（加 Runtime.enable + 长等待 + 超时保护）
const PORT = process.env.PORT || 9223;
const EXT_ID = 'pioohlmbendoaaoegkgfdbmdddfnnadd';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { bws.onopen = r; bws.onerror = () => j(new Error('ws error')); });
  let mid = 0; const pending = new Map();
  bws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const bsend = (m, p = {}, sid) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + m)), 15000); const id = ++mid; pending.set(id, (r) => { clearTimeout(t); res(r); }); bws.send(JSON.stringify(sid ? { id, method: m, params: p, sessionId: sid } : { id, method: m, params: p })); });
  const { result: { targetId } } = await bsend('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup/popup.html`, background: true });
  console.log('popup target created');
  await sleep(2500);
  const { result: { sessionId: swSid } } = await bsend('Target.attachToTarget', { targetId, flatten: true });
  await bsend('Runtime.enable', {}, swSid);
  await sleep(1000);
  const r = await bsend('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.runtime', returnByValue: true }, swSid);
  console.log('chrome.runtime check:', r.result?.result?.value, r.result?.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 150)) : '');
  await bsend('Runtime.evaluate', { expression: 'chrome.runtime.reload()', returnByValue: true }, swSid);
  console.log('reload issued');
  await sleep(1500);
  await bsend('Target.closeTarget', { targetId }).catch(() => {});
  bws.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
