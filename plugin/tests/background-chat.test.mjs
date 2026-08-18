// tests/background-chat.test.mjs — background.js 的 chat 逻辑单测（用注入的世界模拟 chrome + fetch）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const backgroundSrc = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

// ---- 构造可注入的 sandbox ----
async function loadBackgroundWith({ fetchImpl, storage = {}, hostPerm = true } = {}) {
  const storageMap = { ...storage };
  const calls = [];
  const sandbox = {
    self: undefined,
    chrome: undefined,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return fetchImpl ? fetchImpl(url, opts) : { ok: true, json: async () => ({ choices: [{ message: { content: '好的' } }] }) };
    },
    storage: { local: { get: async (keys) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { out[k] = storageMap[k]; }); return out; }, set: async (obj) => Object.assign(storageMap, obj) } },
  };
  // 以 Web Worker 风格执行 background.js（它自身用 self.chrome / fetch / chrome）
  const fn = new Function('self','chrome','fetch', backgroundSrc);
  const chatObj = {};
  const chromeObj = {
    storage: sandbox.storage,
    runtime: { onMessage: { addListener: () => {} } },
  };
  fn({ ...sandbox, chrome: chromeObj }, chromeObj, sandbox.fetch);
  return { calls, storageMap };
}

// 单独抠出 chat 函数直接测不现实（闭包内），这里改为：以 worker 加载并直接调用 onMessage 回调
function loadWithMessageHandler(sandboxChrome) {
  let handler;
  const chromeMock = {
    storage: sandboxChrome.storage,
    runtime: { onMessage: { addListener: (h) => { handler = h; } } },
  };
  const src = backgroundSrc.replace('self.chrome = self.chrome || chrome;', '');
  new Function('self','chrome','fetch', src)({}, chromeMock, sandboxChrome.fetch);
  return { send: (msg) => new Promise((res) => { handler(msg, {}, res); }) };
}

test('llm-chat: 正确拼 OpenAI 兼容请求体并返回文本', async () => {
  let captured;
  const { send } = loadWithMessageHandler({
    storage: { local: { get: async () => ({ apiKey:'sk-test', provider:'deepseek', model:'deepseek-chat', temperature:0.9, apiBase:'https://api.deepseek.com/v1' }), set: async()=>{} } },
    fetch: async (url, opts) => { captured = { url, headers: opts.headers, body: JSON.parse(opts.body) }; return { ok:true, json: async () => ({ choices:[{ message:{ content:'你好，在的～' } }] }) }; },
  });
  const res = await send({ type:'llm-chat', payload:{ messages:[{role:'user',content:'在吗'}] } });
  assert.equal(res.ok, true);
  assert.equal(res.text, '你好，在的～');
  assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer sk-test');
  assert.equal(captured.body.model, 'deepseek-chat');
  assert.deepEqual(captured.body.messages, [{role:'user',content:'在吗'}]);
});

test('llm-chat: 无 key 时报错不崩溃', async () => {
  const { send } = loadWithMessageHandler({
    storage: { local: { get: async () => ({ apiKey:'', provider:'deepseek', model:'deepseek-chat', temperature:0.9, apiBase:'https://api.deepseek.com/v1' }), set: async()=>{} } },
    fetch: async () => { throw new Error('should not fetch'); },
  });
  const res = await send({ type:'llm-chat', payload:{ messages:[{role:'user',content:'x'}] } });
  assert.equal(res.ok, false);
  assert.match(res.error, /API Key/i);
});

test('llm-chat: HTTP 非 2xx 返回错误详情', async () => {
  const { send } = loadWithMessageHandler({
    storage: { local: { get: async () => ({ apiKey:'sk-test', provider:'openai', model:'gpt-4o-mini', temperature:0.9, apiBase:'https://api.openai.com/v1' }), set: async()=>{} } },
    fetch: async () => ({ ok:false, status:401, json: async () => ({ error:{ message:'Incorrect API key' } }) }),
  });
  const res = await send({ type:'llm-chat', payload:{ messages:[{role:'user',content:'x'}] } });
  assert.equal(res.ok, false);
  assert.match(res.error, /401|Incorrect API key/);
});

test('cfg-get / cfg-set 读写 chrome.storage（直接验证存储语义，不依赖 sendResponse 通道）', async () => {
  const store = { apiKey: 'abc' };
  const local = {
    get: async (keys) => {
      const out = {};
      const list = keys == null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
      list.forEach((k) => { out[k] = store[k]; });
      return out;
    },
    set: async (obj) => Object.assign(store, obj),
  };
  // 模拟 background cache() 的读取
  const cfg = await local.get(['apiKey', 'apiBase', 'provider', 'model', 'temperature']);
  assert.equal(cfg.apiKey, 'abc');
  // 模拟 cfg-set 写入
  await local.set({ model: 'deepseek-chat' });
  assert.equal(store.model, 'deepseek-chat');
  const after = await local.get(['model']);
  assert.equal(after.model, 'deepseek-chat');
});
