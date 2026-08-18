#!/usr/bin/env node
// 在客服页上下文执行 JS（Runtime.evaluate），用于探测 IM SDK / 调内部函数
// 用法: node eval.mjs "表达式" [--await]
const expr = process.argv[2];
const useAwait = process.argv.includes('--await');
if (!expr) { console.error('usage: node eval.mjs "<expr>" [--await]'); process.exit(1); }

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
if (!page) { console.error('no cs page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
ws.onopen = async () => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: useAwait, returnByValue: true });
  const res = r.result?.result;
  if (r.result?.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text, null, 1));
  } else {
    console.log(JSON.stringify(res?.value ?? res?.description ?? res, null, 1)?.slice(0, 20000));
  }
  process.exit(0);
};
