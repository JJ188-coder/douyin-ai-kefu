// background pendingHuman 串行化/去重回归：走真实 background 源码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backgroundSrc = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(check, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('等待 background 状态超时');
}

function loadBackground(storageInit = {}, { fetchImpl, onSet, onBadge } = {}) {
  const storageMap = clone(storageInit) || {};
  const controls = { failNextGet: null, failNextSet: null };
  const setCalls = [];
  const tabMessages = [];
  let handler;

  const storage = {
    get(keys, callback) {
      const task = Promise.resolve().then(() => {
        if (controls.failNextGet) {
          const error = controls.failNextGet;
          controls.failNextGet = null;
          throw error;
        }
        const list = keys == null ? Object.keys(storageMap) : (Array.isArray(keys) ? keys : [keys]);
        const out = {};
        list.forEach((k) => { out[k] = storageMap[k]; });
        return clone(out);
      });
      if (typeof callback === 'function') {
        task.then((out) => callback(out), () => callback(undefined));
        return undefined;
      }
      return task;
    },
    set(obj, callback) {
      const task = Promise.resolve().then(async () => {
        if (controls.failNextSet) {
          const error = controls.failNextSet;
          controls.failNextSet = null;
          throw error;
        }
        const next = clone(obj);
        setCalls.push(next);
        if (onSet) await onSet(next);
        Object.assign(storageMap, next);
      });
      if (typeof callback === 'function') {
        task.then(() => callback(), () => callback());
        return undefined;
      }
      return task;
    },
  };

  const chromeMock = {
    storage: { local: storage },
    runtime: { onMessage: { addListener: (h) => { handler = h; } }, lastError: null },
    tabs: {
      query: (_query, callback) => callback([{ id: 1 }]),
      sendMessage: (tabId, message, callback) => {
        tabMessages.push({ tabId, message });
        if (callback) callback();
      },
    },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async (opts) => { if (onBadge) await onBadge(opts); } },
    notifications: { create: () => {} },
  };
  const src = backgroundSrc.replace('self.chrome = self.chrome || chrome;', '');
  const fn = new Function('self', 'chrome', 'fetch', src);
  fn(chromeMock, chromeMock, fetchImpl || (async () => ({ ok: true, json: async () => ({ code: 0 }) })));

  return {
    storageMap,
    controls,
    setCalls,
    tabMessages,
    emit: (msg) => handler(msg, {}, () => {}),
    send: (msg, timeoutMs = 500) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sendResponse timeout')), timeoutMs);
      try {
        handler(msg, {}, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    }),
  };
}

test('pendingHuman 同会话同买家 10 分钟内去重，不同问题正常新增', async () => {
  const { storageMap, emit } = loadBackground();
  const payload = { conversationId: 'C1', buyerText: '怎么退款', reply: '帮您确认一下' };
  emit({ type: 'aics-event', channel: 'needs-human', payload });
  emit({ type: 'aics-event', channel: 'needs-human', payload });
  emit({ type: 'aics-event', channel: 'needs-human', payload: { ...payload, buyerText: '别的问题' } });
  await waitFor(() => (storageMap.pendingHuman || []).length >= 2);
  const list = storageMap.pendingHuman || [];
  assert.equal(list.length, 2);
  assert.equal(list.filter((x) => x.buyer === '怎么退款').length, 1);
  assert.equal(list.filter((x) => x.buyer === '别的问题').length, 1);
});

test('pending-list 排在并发新增的 storage 写入之后', async () => {
  const started = deferred();
  const release = deferred();
  let blocked = false;
  const env = loadBackground({}, {
    onSet: async (obj) => {
      if (!blocked && Object.prototype.hasOwnProperty.call(obj, 'pendingHuman')) {
        blocked = true;
        started.resolve();
        await release.promise;
      }
    },
  });

  env.emit({ type: 'aics-event', channel: 'needs-human', payload: { conversationId: 'C2', buyerText: '订单去哪了', reply: '我帮您确认一下' } });
  await started.promise;
  const listPromise = env.send({ type: 'pending-list' });
  let settled = false;
  listPromise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  release.resolve();

  const result = await listPromise;
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].conv, 'C2');
});

test('pending-done/list/clear 按调用顺序串行，done 使用 immutable update', async () => {
  const env = loadBackground({ pendingHuman: [
    { id: 'h1', t: 1, conv: 'C3', buyer: '问题一', reply: '回复一', kind: 'human', done: false },
    { id: 'h2', t: 2, conv: 'C3', buyer: '问题二', reply: '回复二', kind: 'human', done: false },
  ] });

  const [done, listed, cleared] = await Promise.all([
    env.send({ type: 'pending-done', payload: { id: 'h1', conversationId: 'spoofed' } }),
    env.send({ type: 'pending-list' }),
    env.send({ type: 'pending-clear' }),
  ]);
  assert.equal(done.ok, true);
  assert.equal(listed.list.find((x) => x.id === 'h1').done, true);
  assert.equal(cleared.ok, true);
  assert.deepEqual(env.storageMap.pendingHuman, []);
});

test('pending 命令传播 storage 失败，queue 恢复且失败的 done 不 unmute', async () => {
  const env = loadBackground({ pendingHuman: [
    { id: 'h1', t: 1, conv: 'real-conv', buyer: '问题', reply: '回复', kind: 'human', done: false },
  ] });

  env.controls.failNextGet = new Error('get failed');
  const listError = await env.send({ type: 'pending-list' });
  assert.equal(listError.ok, false);
  assert.match(listError.error, /get failed/);
  assert.equal((await env.send({ type: 'pending-list' })).list.length, 1);

  env.controls.failNextSet = new Error('set failed');
  const doneError = await env.send({ type: 'pending-done', payload: { id: 'h1', conversationId: 'spoofed' } });
  assert.equal(doneError.ok, false);
  assert.match(doneError.error, /set failed/);
  assert.equal(env.storageMap.pendingHuman[0].done, false);
  assert.equal(env.tabMessages.length, 0);

  const doneOk = await env.send({ type: 'pending-done', payload: { id: 'h1', conversationId: 'spoofed' } });
  assert.equal(doneOk.ok, true);
  assert.equal(env.tabMessages.length, 1);
  assert.equal(env.tabMessages[0].message.payload.conversationId, 'real-conv');

  env.controls.failNextSet = new Error('clear failed');
  const clearError = await env.send({ type: 'pending-clear' });
  assert.equal(clearError.ok, false);
  assert.match(clearError.error, /clear failed/);
  assert.equal(env.storageMap.pendingHuman.length, 1);
  assert.equal((await env.send({ type: 'pending-clear' })).ok, true);
  assert.deepEqual(env.storageMap.pendingHuman, []);
});

test('pending-done 只在没有其他 human 条目时按存储 conv unmute，followup 不触发', async () => {
  const env = loadBackground({ pendingHuman: [
    { id: 'h1', t: 1, conv: 'real-conv', buyer: '问题一', reply: '回复一', kind: 'human', done: false },
    { id: 'h2', t: 2, conv: 'real-conv', buyer: '问题二', reply: '回复二', kind: 'human', done: false },
    { id: 'f1', t: 3, conv: 'real-conv', buyer: '承诺事项', reply: '我让专员联系您', kind: 'followup', done: false },
  ] });

  await env.send({ type: 'pending-done', payload: { id: 'h1', conversationId: 'spoofed' } });
  assert.equal(env.tabMessages.length, 0);
  await env.send({ type: 'pending-done', payload: { id: 'f1', conversationId: 'spoofed' } });
  assert.equal(env.tabMessages.length, 0);
  await env.send({ type: 'pending-done', payload: { id: 'h2', conversationId: 'spoofed' } });
  assert.equal(env.tabMessages.length, 1);
  assert.equal(env.tabMessages[0].message.payload.conversationId, 'real-conv');
});

test('飞书 human 提示按 reply 区分待人工解除与仅预警', async () => {
  const calls = [];
  const env = loadBackground({ feishuWebhook: 'https://example.invalid/hook' }, {
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ code: 0 }) };
    },
  });

  env.emit({ type: 'aics-event', channel: 'needs-human', payload: { conversationId: 'C4', buyerText: '问题', reply: '已回复' } });
  await waitFor(() => calls.length === 1);
  const firstText = JSON.parse(calls[0].opts.body).content.text;
  assert.match(firstText, /待人工处理后解除/);
  assert.doesNotMatch(firstText, /15 分钟/);

  env.emit({ type: 'aics-event', channel: 'needs-human', payload: { conversationId: 'C5', buyerText: '投诉', reply: '' } });
  await waitFor(() => calls.length === 2);
  const secondText = JSON.parse(calls[1].opts.body).content.text;
  assert.match(secondText, /仅预警/);
  assert.doesNotMatch(secondText, /15 分钟/);
});

test('角标故障不阻断已处理解静音，也不谎报已经完成的清空失败', async () => {
  const env = loadBackground({ pendingHuman: [
    { id: 'h1', conv: 'C1', kind: 'human', done: false },
  ] }, { onBadge: async () => { throw new Error('合成角标故障'); } });
  const done = await env.send({ type: 'pending-done', payload: { id: 'h1' } });
  assert.equal(done.ok, true);
  assert.equal(env.storageMap.pendingHuman[0].done, true);
  assert.equal(env.tabMessages.length, 1);
  assert.equal((await env.send({ type: 'pending-clear' })).ok, true);
  assert.deepEqual(env.storageMap.pendingHuman, []);
});

test('刷新角标期间新加入人工事项，旧事项完成不能解除新静音', async () => {
  const started = deferred(), release = deferred();
  let badges = 0;
  const env = loadBackground({ pendingHuman: [
    { id: 'h1', conv: 'C1', kind: 'human', done: false },
  ] }, { onBadge: async () => {
    if (++badges === 1) { started.resolve(); await release.promise; }
  } });
  const done = env.send({ type: 'pending-done', payload: { id: 'h1' } });
  await started.promise;
  env.emit({ type: 'aics-event', channel: 'needs-human', payload: { conversationId: 'C1', buyerText: '新问题', reply: '帮您确认一下' } });
  const latest = await env.send({ type: 'pending-list' });
  assert.equal(latest.list.filter((x) => !x.done).length, 1);
  release.resolve();
  assert.equal((await done).ok, true);
  assert.equal(env.tabMessages.length, 0);
});

test('已处理落盘后读取最新待办失败，重试仍可恢复解静音', async () => {
  let fail = true;
  const env = loadBackground({ pendingHuman: [
    { id: 'h1', conv: 'C1', kind: 'human', done: false },
  ] }, { onBadge: async () => {
    if (fail) {
      fail = false;
      env.controls.failNextGet = new Error('合成最新待办读取失败');
    }
  } });
  const failed = await env.send({ type: 'pending-done', payload: { id: 'h1' } });
  assert.equal(failed.ok, false);
  assert.equal(env.storageMap.pendingHuman[0].done, true);
  assert.equal(env.tabMessages.length, 0);
  assert.equal((await env.send({ type: 'pending-done', payload: { id: 'h1' } })).ok, true);
  assert.equal(env.tabMessages.length, 1);
  assert.equal(env.tabMessages[0].message.payload.conversationId, 'C1');
});
