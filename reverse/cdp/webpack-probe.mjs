#!/usr/bin/env node
// 从页面 webpack 运行时提取 require，并搜索模块工厂源码
// 用法: node webpack-probe.mjs "<正则>" [--load] [--ctx 80]
const pattern = process.argv[2];
const doLoad = process.argv.includes('--load');
const ctx = process.argv.includes('--ctx') ? Number(process.argv[process.argv.indexOf('--ctx') + 1]) : 80;
if (!pattern) { console.error('usage: node webpack-probe.mjs "<regex>" [--load] [--ctx N]'); process.exit(1); }

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };

ws.onopen = async () => {
  // 1) 提取 require
  const boot = await send('Runtime.evaluate', { expression: `
    (() => {
      if (window.__req) return 'cached';
      const chunk = window.webpackChunklife_im_platform;
      if (!chunk) return 'no-chunk';
      chunk.push([[Math.floor(Math.random()*1e9)], {}, (r) => { window.__req = r; }]);
      return window.__req ? 'ok' : 'fail';
    })()`, returnByValue: true });
  const st = boot.result?.result?.value;
  if (st !== 'ok' && st !== 'cached') { console.log('boot:', st); process.exit(1); }

  // 2) 遍历模块工厂做正则匹配（可选：先 require 加载再匹配导出）
  const probe = await send('Runtime.evaluate', { expression: `
    (() => {
      const req = window.__req;
      const mods = req.m || {};
      const re = new RegExp(${JSON.stringify(pattern)}, 'i');
      const out = [];
      for (const [id, factory] of Object.entries(mods)) {
        try {
          const src = factory.toString();
          const m = src.match(re);
          if (m) {
            const i = src.search(re);
            out.push({ id, match: m[0].slice(0, 120), snippet: src.slice(Math.max(0, i - ${ctx}), i + ${ctx}) });
          }
        } catch (e) {}
      }
      return { total: Object.keys(mods).length, hits: out.slice(0, 40) };
    })()`, returnByValue: true });
  const val = probe.result?.result?.value;
  if (!val) { console.log(JSON.stringify(probe.result).slice(0, 2000)); process.exit(1); }
  console.log('modules scanned:', val.total, '| hits:', val.hits.length);
  for (const h of val.hits) console.log('---', h.id, '---', h.snippet.replace(/\n/g, ' '));
  process.exit(0);
};
