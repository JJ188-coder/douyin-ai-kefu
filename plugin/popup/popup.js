// popup.js — 弹层逻辑：读写 chrome.storage、命令下发到 content/host、事件回放
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const toast = (msg) => { const el = $('testHint'); if (el) { el.textContent = msg; setTimeout(() => (el.textContent=''), 4000); } };

  // ---- 事件日志 ----
  const logsEl = $('logs');
  function log(level, text) {
    if (!logsEl) return;
    const div = document.createElement('div');
    div.className = level === 'error' ? 'err' : '';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logsEl.appendChild(div);
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  // ---- 拉配置回填 ----
  async function load() {
    const c = await chrome.storage.local.get([
      'provider','model','apiKey','temperature','autoSend','acceptPreview',
      'profile','kb','minIntervalMs','maxRepliesPerConv','dailyLimit','quietEnabled','quietFrom','quietTo','enabled','sent','stateCache',
    ]);
    const set = (id, v) => { const el = $(id); if (el && v !== undefined) el.value = String(v); };
    set('provider', c.provider || 'deepseek');
    set('model', c.model || '');
    set('apiKey', c.apiKey || '');
    set('temperature', c.temperature ?? 0.9);
    set('autoSend', c.autoSend === true ? 'true' : 'false');
    set('profile', c.profile || '');
    set('kb', (c.kb && c.kb.join('\n')) || '');
    set('minInterval', c.minIntervalMs || '15000');
    set('maxPerTurn', c.maxRepliesPerConv ?? 1);
    set('dailyLimit', c.dailyLimit || 200);
    set('quietEnabled', c.quietEnabled === true ? 'true' : 'false');
    set('quietFrom', c.quietFrom ?? 0);
    set('quietTo', c.quietTo ?? 0);

    // 回显最近的历史事件日志（持久化在 storage.events，popup 重开不丢）
    const ev = await chrome.storage.local.get('events');
    const evs = Array.isArray(ev.events) ? ev.events : [];
    if (evs.length) {
      logsEl.innerHTML = '';
      for (const e of evs.slice(-50)) {
        log(e.level || 'ok', e.text || e.channel || '');
      }
    }
    // 顶部状态：用真实配置（storage）显示，不依赖可能过期的 stateCache
    $('stateText').textContent = (c.enabled !== false ? '自动回复已开启' : '自动回复已关闭') + (c.autoSend === true ? ' · 自动发送' : ' · 仅预览');
    $('masterToggle').checked = c.enabled !== false;
    // 页面连接：探测客服台页面是否打开（host_permissions 覆盖 douyin，能读到 url）
    chrome.tabs.query({}, (tabs) => {
      const hasCs = (tabs || []).some(t => t.url && t.url.includes('life.douyin.com/cs'));
      $('storeBadge').className = 'badge ' + (hasCs ? 'ok' : 'off');
      $('storeBadge').textContent = hasCs ? '页面已连接' : '页面未连接（请打开客服台）';
    });
  }

  // ---- 保存 ----
  async function save() {
    const cfg = {
      provider: $('provider').value,
      model: $('model').value.trim(),
      apiKey: $('apiKey').value.trim(),
      temperature: Number($('temperature').value) || 0.9,
      autoSend: $('autoSend').value === 'true',
      profile: $('profile').value.trim(),
      kb: ($('kb').value || '').split('\n').map((s) => s.trim()).filter(Boolean),
      minIntervalMs: Number($('minInterval').value) || 15000,
      maxRepliesPerConv: Number($('maxPerTurn').value) || 1,
      dailyLimit: Number($('dailyLimit').value) || 200,
      quietEnabled: $('quietEnabled').value === 'true',
      quietFrom: Number($('quietFrom').value) || 0,
      quietTo: Number($('quietTo').value) || 0,
    };
    // 把配置写 storage，并通知 content 应用
    await chrome.storage.local.set(cfg);
    dispatch('apply-config', cfg);
    toast('已保存并下发');
  }

  // ---- 给页面下发命令（经 ISOLATED bridge 转发到 MAIN）----
  function dispatch(cmd, payload = {}) {
    window.postMessage({ __aics: 'cmd', cmd, payload }, window.location.origin);
  }

  // ---- 事件监听（后台转发的页面事件回放）----
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'aics-event') return;
    const { channel, payload } = msg;
    if (channel === 'sent') log('ok', `已回复 ${(payload.reply||'').slice(0,60)}`);
    else if (channel === 'preview') log('ok', `AI建议回复：${(payload.reply||'').slice(0,60)}`);
    else if (channel === 'notice') log(payload && payload.level === 'error' ? 'error' : 'ok', payload && payload.text);
    else if (channel === 'assigned') log('ok', `新会话已转人工接管：${payload.conversationId}`);
    else if (channel === 'state') {
      const st = payload;
      chrome.storage.local.set({ stateCache: { ...st, store: true } });
      $('stateText').textContent = (st.enabled ? '自动回复已开启' : '自动回复已关闭') + (st.autoSend ? ' · 自动发送' : ' · 仅预览');
      $('storeBadge').className = 'badge ' + (st.store !== false ? 'ok' : 'off');
      $('storeBadge').textContent = st.store !== false ? '页面已连接' : '页面未连接';
      $('masterToggle').checked = st.enabled === true;
    }
  });

  // ---- 按钮 ----
  $('masterToggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const stateCache = { ...(await chrome.storage.local.get('stateCache')).stateCache, enabled: on };
    chrome.storage.local.set({ enabled: on, stateCache });
    if (on) { save(); dispatch('enable', { autoSend: $('autoSend').value === 'true' }); }
    else dispatch('disable');
    toast(on ? '接管已开启' : '接管已关闭');
  });

  $('btnSave') && $('btnSave').addEventListener('click', save);
  $('btnRefresh').addEventListener('click', async () => { await load(); dispatch('get-state'); toast('已刷新'); });
  $('btnTest').addEventListener('click', () => {
    dispatch('send-test', { conversationId: '', text: '联调：在吗？周末还有房吗？' });
    toast('已发送测试消息（走接管管线）');
  });
  $('btnResetDaily').addEventListener('click', async () => {
    await chrome.storage.local.set({ dailyCount: 0 });
    dispatch('reset-daily');
    toast('今日计数已重置');
  });
  $('btnClearLog').addEventListener('click', () => { logsEl.innerHTML = '（空）'; });

  // ---- 对话记录：显示条数 + 导出 JSON 到本地 ----
  async function refreshChatCount() {
    const { chatlog } = await chrome.storage.local.get('chatlog');
    const n = Array.isArray(chatlog) ? chatlog.length : 0;
    const el = $('chatCount');
    if (el) el.textContent = n ? '已记录 ' + n + ' 条' : '暂无记录';
  }
  $('btnExportChat').addEventListener('click', async () => {
    const { chatlog } = await chrome.storage.local.get('chatlog');
    const arr = Array.isArray(chatlog) ? chatlog : [];
    if (!arr.length) { toast('暂无对话记录'); return; }
    const payload = {
      exportedAt: new Date().toISOString(),
      shop: '您的店铺名称',
      count: arr.length,
      notes: 'who: buyer=买家 / ai=AI自动回复 / staff=人工客服；conv 为会话ID后12位',
      entries: arr,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download({ url, filename: `douyin_cs_chatlog_${stamp}.json`, saveAs: false }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      toast(`已导出 ${arr.length} 条到下载目录`);
    });
  });
  refreshChatCount();
  // 所有输入 blur 自动保存
  document.querySelectorAll('input,select,textarea').forEach((el) => el.addEventListener('change', save));

  window.addEventListener('load', () => { load(); dispatch('get-state'); });
})();
