#!/usr/bin/env node
// 截图当前客服页
const out = process.argv[2] || `shot-${Date.now()}.png`;
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
ws.onopen = async () => {
  await send('Page.enable');
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r.result) { console.error('fail', JSON.stringify(r).slice(0, 300)); process.exit(1); }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('saved', out);
  process.exit(0);
};
