#!/usr/bin/env node
// cdp-inject-code.mjs — 把本地 JS 文件注入客服页主世界并执行
// 用法: node inject-code.mjs <file1> [<file2> ...] [--eval "<js>"] [--fn-call "agent.enable({})"]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = [];
let evalJs = null, fnCall = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--eval') evalJs = args[++i];
  else if (args[i] === '--fn-call') fnCall = args[++i];
  else if (args[i].endsWith('.js')) files.push(args[i]);
}

const run = async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  ws.onopen = async () => {
    // 1) 逐个注入文件
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      const wrapped = `(()=>{const script=document.createElement('script');script.textContent=${JSON.stringify(code)};(document.head||document.documentElement).appendChild(script);return document.currentScript?false:true})()`;
      await send('Runtime.evaluate', { expression: wrapped, returnByValue: true });
      console.log('injected:', f);
    }
    // 2) 可选 eval
    if (evalJs) {
      const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.result) {
        console.log('eval ->', JSON.stringify(r.result.result.value ?? r.result.result.description).slice(0, 3000));
      } else if (r.result && r.result.exceptionDetails) {
        console.log('eval EXC ->', r.result.exceptionDetails.exception?.description?.slice(0, 800) || r.result.exceptionDetails.text);
      }
    }
    // 3) 可选 fn call
    if (fnCall) {
      const r = await send('Runtime.evaluate', { expression: fnCall, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.result) {
        console.log('call ->', JSON.stringify(r.result.result.value ?? r.result.result.description).slice(0, 3000));
      } else if (r.result && r.result.exceptionDetails) {
        console.log('call EXC ->', r.result.exceptionDetails.exception?.description?.slice(0, 800) || r.result.exceptionDetails.text);
      }
    }
    process.exit(0);
  };
  setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 20000);
};
run();
