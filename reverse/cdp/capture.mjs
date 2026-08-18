#!/usr/bin/env node
// CDP 抓包工具：连接 9222 上的抖音来客客服页，记录 WebSocket 帧与 /napi/ 请求
// 用法: node capture.mjs [--reload] [--seconds 60] [--out capture.log]
import { writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const RELOAD = args.includes('--reload');
const SECONDS = Number(opt('seconds', 60));
const OUT = opt('out', `capture-${Date.now()}.log`);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
if (!page) { console.error('找不到客服页 tab'); process.exit(1); }
console.log('attach:', page.title, page.url.slice(0, 100));
console.log('log ->', OUT);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const log = (obj) => {
  const line = JSON.stringify(obj);
  appendFileSync(OUT, line + '\n');
};

const wsUrls = new Map(); // requestId -> url

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res } = pending.get(msg.id);
    pending.delete(msg.id);
    res(msg.result);
    return;
  }
  const { method, params } = msg;
  switch (method) {
    case 'Network.webSocketCreated':
      wsUrls.set(params.requestId, params.url);
      log({ t: Date.now(), kind: 'ws-created', url: params.url, requestId: params.requestId });
      console.log('[WS created]', params.url);
      break;
    case 'Network.webSocketFrameSent': {
      const p = params.response.payloadData;
      log({ t: Date.now(), kind: 'ws-send', url: wsUrls.get(params.requestId), op: params.response.opcode, len: p.length, data: p.slice(0, 4000) });
      break;
    }
    case 'Network.webSocketFrameReceived': {
      const p = params.response.payloadData;
      log({ t: Date.now(), kind: 'ws-recv', url: wsUrls.get(params.requestId), op: params.response.opcode, len: p.length, data: p.slice(0, 4000) });
      break;
    }
    case 'Network.requestWillBeSent': {
      const u = params.request.url;
      if (u.includes('/napi/') || u.includes('/cs/')) {
        log({ t: Date.now(), kind: 'req', id: params.requestId, method: params.request.method, url: u, headers: params.request.headers, post: params.request.postData?.slice(0, 3000) });
        console.log('[REQ]', params.request.method, u.slice(0, 120));
      }
      break;
    }
    case 'Network.responseReceived': {
      const u = params.response.url;
      if (u.includes('/napi/') || u.includes('/cs/')) {
        log({ t: Date.now(), kind: 'resp', id: params.requestId, status: params.response.status, url: u, mime: params.response.mimeType });
      }
      break;
    }
  }
};

ws.onopen = async () => {
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');
  if (RELOAD) {
    console.log('reloading page to capture bootstrap...');
    await send('Page.reload', { ignoreCache: false });
  }
  console.log(`capturing ${SECONDS}s ...`);
  setTimeout(() => { console.log('done.'); process.exit(0); }, SECONDS * 1000);
};
