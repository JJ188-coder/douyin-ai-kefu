import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');

function boot(initial = {}) {
  const storage = structuredClone(initial);
  const controls = new Map();
  const commands = [];
  const events = {};
  const document = {
    getElementById(id) {
      if (!controls.has(id)) controls.set(id, {
        value: '', handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; },
        appendChild() {}, querySelectorAll: () => [],
      });
      return controls.get(id);
    },
    createElement: () => ({}),
    querySelectorAll: () => [],
  };
  const chrome = {
    storage: { local: {
      get: async () => structuredClone(storage),
      set: async (value) => Object.assign(storage, structuredClone(value)),
      remove: async (key) => { delete storage[key]; },
    } },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) { commands.push(msg); cb?.({ ok: true, list: [] }); },
    },
    tabs: { query: (_, cb) => cb([]) },
  };
  const window = { addEventListener: (type, fn) => { events[type] = fn; } };
  new Function('document', 'chrome', 'window', 'setTimeout', src)(document, chrome, window, () => 0);
  return { storage, controls, commands, events };
}

async function load(app) {
  app.events.load();
  await new Promise(setImmediate);
}

test('popup 保存并重新打开后保留温度0与人工接管不静音', async () => {
  const app = boot({ temperature: 0, staffMuteMinutes: 0 });
  await load(app);
  assert.equal(app.controls.get('temperature').value, '0');
  assert.equal(app.controls.get('staffMuteMinutes').value, '0');
  await app.controls.get('btnSave').handlers.click();
  assert.equal(app.storage.temperature, 0);
  assert.equal(app.storage.staffMuteMinutes, 0);
  await load(app);
  assert.equal(app.controls.get('temperature').value, '0');
  assert.equal(app.controls.get('staffMuteMinutes').value, '0');
});

test('popup 空输入仍使用原来的默认值', async () => {
  const app = boot();
  await app.controls.get('btnSave').handlers.click();
  assert.equal(app.storage.temperature, 0.9);
  assert.equal(app.storage.staffMuteMinutes, 15);
});

test('重置今日计数清除实际使用的daily记录，并通知页面重置', async () => {
  const app = boot({ daily: { date: '2026-09-05', count: 200 } });
  await app.controls.get('btnResetDaily').handlers.click();
  assert.equal(Object.hasOwn(app.storage, 'daily'), false);
  assert.ok(app.commands.some((msg) => msg.type === 'aics-cmd' && msg.cmd === 'reset-daily'));
});
