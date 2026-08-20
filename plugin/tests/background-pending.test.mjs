// background pendingHuman 串行化/去重回归：同会话同买家 10 分钟内只入队一次（走真实 background 源码）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backgroundSrc = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function loadBackground(storageInit = {}) {
  const storageMap = { ...storageInit };
  let handler;
  const chromeMock = {
    storage: { local: {
      get: async (keys) => {
        const out = {};
        const list = keys == null ? Object.keys(storageMap) : (Array.isArray(keys) ? keys : [keys]);
        list.forEach((k) => { out[k] = storageMap[k]; });
        return out;
      },
      set: async (obj) => Object.assign(storageMap, obj),
    } },
    runtime: { onMessage: { addListener: (h) => { handler = h; } }, lastError: null },
    tabs: { query: () => {}, sendMessage: () => {} },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    notifications: { create: () => {} },
  };
  const src = backgroundSrc.replace('self.chrome = self.chrome || chrome;', '');
  const fn = new Function('self', 'chrome', 'fetch', src);
  fn(chromeMock, chromeMock, async () => ({ ok: true, json: async () => ({ code: 0 }) }));
  return { storageMap, send: (msg) => { handler(msg, {}, () => {}); } };
}

test('pendingHuman 同会话同买家 10 分钟内去重，不同问题正常新增', async () => {
  const { storageMap, send } = loadBackground();
  const payload = { conversationId: 'C1', buyerText: '怎么退款', reply: '帮您确认一下' };
  await send({ type: 'aics-event', channel: 'needs-human', payload });
  await send({ type: 'aics-event', channel: 'needs-human', payload });   // 重推同内容
  await send({ type: 'aics-event', channel: 'needs-human', payload: { ...payload, buyerText: '别的问题' } });
  // aics-event 处理器不返回 sendResponse（return false），send 的 Promise 不会 resolve；
  // 这里改为直接轮询 storage，等 withPendingHuman 落盘完成
  for (let i = 0; i < 50; i++) {
    if ((storageMap.pendingHuman || []).length >= 2) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const list = storageMap.pendingHuman || [];
  assert.equal(list.length, 2);
  assert.equal(list.filter(x => x.buyer === '怎么退款').length, 1);
  assert.equal(list.filter(x => x.buyer === '别的问题').length, 1);
});
