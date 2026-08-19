#!/usr/bin/env node
// restore-config.mjs — 一键恢复插件配置（人设/知识库/API Key/开关）到新电脑的浏览器里
//
// 用法：
//   1. 先用调试模式启动 Chrome（插件已通过 chrome://extensions 加载解压安装好）：
//      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//        --remote-debugging-port=9223 --user-data-dir=/tmp/aics-chrome-profile
//   2. 保持 Chrome 开着，另开终端运行：
//      node reverse/cdp/restore-config.mjs
//   3. 看到 OK 即完成。打开插件 popup 可看到知识库 37 条、人设、模型等已全部就位。
//
// 原理：CDP 后台开一个插件 popup 页面，在同源环境里直接写 chrome.storage.local。
// 插件 ID 按安装路径生成，所以本脚本不猜 ID，而是枚举所有 target 找 popup/background。

const CONFIG_PATH = new URL('../../docs/handover-config.json', import.meta.url);

const ver = await (await fetch('http://127.0.0.1:9223/json/version')).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });

let mid = 0;
const pending = new Map();
bws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++mid;
  pending.set(id, res);
  bws.send(JSON.stringify(Object.assign({ id, method, params }, sessionId ? { sessionId } : {})));
});

// 找扩展 ID：从现有 target（popup/background worker）里挖；没有就翻 manifest 目录挨个试
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
let extId = null;
for (const t of targets) {
  const m = (t.url || '').match(/chrome-extension:\/\/([a-z]{32})/);
  if (m) { extId = m[1]; break; }
}
if (!extId) {
  // 没有现成 target 时（插件刚装、后台 worker 未唤醒），只能让用户先开一次 popup。
  console.error('没找到插件的 target。请先在 Chrome 里点一下插件图标打开 popup，然后再跑本脚本。');
  process.exit(1);
}
console.log('ext id:', extId);

const { result: { targetId } } = await send('Target.createTarget', {
  url: `chrome-extension://${extId}/popup/popup.html`, background: true,
});
await new Promise((r) => setTimeout(r, 1000));
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });

const { readFileSync } = await import('fs');
const config = readFileSync(CONFIG_PATH, 'utf8');
const expr = `(async () => {
  const data = ${config};
  await chrome.storage.local.set(data);
  const chk = await chrome.storage.local.get(null);
  return JSON.stringify({ written: Object.keys(data).length, kb: (chk.kb || []).length, hasKey: !!chk.apiKey, profile: !!chk.profile });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
const v = r.result && r.result.result ? r.result.result.value : null;
console.log(v ? 'OK ' + v : 'FAIL ' + JSON.stringify(r).slice(0, 300));

await send('Target.closeTarget', { targetId });
bws.close();
process.exit(0);
