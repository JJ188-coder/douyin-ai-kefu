// content.js — 入口（MAIN world）。manifest 已把 core/* 先注入，本文件仅做启动标记。
// 持久化配置由 ISOLATED world 的 host-bridge.js 读取 chrome.storage 后 postMessage 下发
// （MAIN world 访问不到 chrome.* API，不要在这里读 storage）。
(() => {
  'use strict';
  console.log('[aics-content] injected; host boot 负责装配，配置由 host-bridge 下发');
})();
