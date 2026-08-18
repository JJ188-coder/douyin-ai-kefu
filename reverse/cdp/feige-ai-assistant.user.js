// ==UserScript==
// @name         飞鸽 AI 客服助手
// @namespace    https://github.com/jacobcao96-prog/feige-ai-assistant
// @version      1.2
// @description  注入飞鸽Web页面，监听消息并提交AI处理，自动填入回复
// @author       jacobcao96-prog
// @match        https://im.jinritemai.com/*
// @match        https://fxg.jinritemai.com/*
// @match        https://*.jinritemai.com/*
// @downloadURL  https://raw.githubusercontent.com/jacobcao96-prog/feige-ai-assistant/main/feige-ai-assistant.user.js
// @updateURL    https://raw.githubusercontent.com/jacobcao96-prog/feige-ai-assistant/main/feige-ai-assistant.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const BRIDGE_URL = 'http://localhost:8765';
    const POLL_INTERVAL = 1000; 

    console.log('[飞鸽AI助手] v1.1 已注入', window.location.href);

    // ========== DOM 选择器（动态探测） ==========
    let SELECTORS = {
        chatContainer: null,
        messageItem: null,
        messageText: null,
        senderName: null,
        inputBox: null,
        sendBtn: null,
    };

    let lastProcessedMsg = '';
    let processingMsg = new Set();
    let sentMessages = new Set();  // 过滤自己发出的消息，防止回环

    // ========== DOM 自动探测 ==========
    function probeDOM() {
        console.log('[飞鸽AI助手] 开始探测 DOM...');
        let report = { url: window.location.href, title: document.title, findings: {} };

        // 1. 输入框
        let textareas = document.querySelectorAll('textarea');
        report.findings.textareas = [];
        textareas.forEach((t, i) => {
            if (t.offsetParent) {
                report.findings.textareas.push({
                    index: i,
                    className: t.className,
                    placeholder: (t.placeholder || '').substring(0, 50),
                    visible: true
                });
            }
        });
        
        let contenteditables = document.querySelectorAll('[contenteditable="true"]');
        report.findings.contenteditables = [];
        contenteditables.forEach((e, i) => {
            if (e.offsetParent) {
                report.findings.contenteditables.push({
                    index: i,
                    tagName: e.tagName,
                    className: e.className,
                    visible: true
                });
            }
        });

        // 2. 发送按钮 - 找 textarea/contenteditable 附近最近的 button
        report.findings.sendButtons = [];
        let inputEl = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
        if (inputEl) {
            // 往上找容器，再往下找 button
            let container = inputEl.closest('div[class],form,section');
            if (container) {
                let btns = container.querySelectorAll('button');
                btns.forEach((b,i) => {
                    report.findings.sendButtons.push({
                        index: i,
                        className: b.className,
                        text: (b.textContent||'').trim().substring(0,20),
                        title: (b.title||'').substring(0,20),
                        disabled: b.disabled
                    });
                });
            }
        }

        // 3. 找所有可见的、含文本的元素，分析层级
        let allTextElements = document.querySelectorAll('div,span,p');
        let candidates = [];
        allTextElements.forEach(el => {
            let text = (el.textContent || '').trim();
            // 找可能的消息文本：子元素少、文本长度适中、可见
            if (text.length > 5 && text.length < 500 && el.children.length <= 2 && el.offsetParent) {
                candidates.push({
                    tag: el.tagName,
                    className: el.className?.substring(0, 80),
                    textPreview: text.substring(0, 40),
                    childCount: el.children.length
                });
            }
        });

        // 去重，取前 20 个
        let seen = new Set();
        let unique = [];
        for (let c of candidates) {
            let key = c.tag + '|' + c.className;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(c);
                if (unique.length >= 20) break;
            }
        }
        report.findings.textCandidates = unique;

        // 4. 找最可能的消息容器（有很多文本子元素的 scroll 区域）
        let scrollDivs = document.querySelectorAll('div[class]');
        let containers = [];
        scrollDivs.forEach(div => {
            if (!div.offsetParent) return;
            let cls = div.className?.toLowerCase() || '';
            let hasScroll = cls.includes('scroll') || cls.includes('list') || cls.includes('chat') || cls.includes('msg') || cls.includes('conversation');
            if (hasScroll || div.querySelectorAll('div,span,p').length > 50) {
                containers.push({
                    className: div.className?.substring(0, 80),
                    tag: div.tagName,
                    totalDescendants: div.querySelectorAll('*').length,
                    textLength: (div.textContent||'').length
                });
                if (containers.length >= 10) return;
            }
        });
        report.findings.containers = containers;

        // 上报探测结果
        console.log('[飞鸽AI助手] DOM探测完成，上报结果');
        GM_xmlhttpRequest({
            method: 'POST',
            url: BRIDGE_URL + '/dom-report',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(report),
            onload: function(r) {
                console.log('[飞鸽AI助手] DOM探测已上报:', r.responseText);
                // 接收桥返回的选择器建议
                try {
                    let sel = JSON.parse(r.responseText);
                    if (sel.selectors) {
                        SELECTORS = sel.selectors;
                        console.log('[飞鸽AI助手] 已应用选择器:', SELECTORS);
                        // 重新开始监听
                        observeMessages();
                    }
                } catch(e) {}
            }
        });
    }

    // ========== 从文本提取 ==========
    function extractOrderIds(text) {
        const patterns = [/\b\d{18,20}\b/g, /\b[A-Z0-9]{15,30}\b/g];
        const ids = [];
        for (const p of patterns) {
            const m = text.match(p);
            if (m) ids.push(...m);
        }
        return [...new Set(ids)];
    }

    function extractIntent(text) {
        const kw = {
            refund: /退款|退货|退钱|退款申请|退换/,
            logistics: /物流|快递|发货|单号|到哪里了|还没收到/,
            intercept: /拦截|追回|召回|不要了|退回/,
            after_sale: /售后|坏了|破损|质量问题|差评/,
            complain: /投诉|举报|客服|人工/,
        };
        return Object.entries(kw).filter(([,re]) => re.test(text)).map(([k]) => k);
    }

    // ========== 输入操作 ==========
    function findInputBox() {
        for (const sel of ['textarea', '[contenteditable="true"]']) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (el.offsetParent) return el;
            }
        }
        return null;
    }

    function findSendBtn() {
        let input = findInputBox();
        if (!input) return null;
        let container = input.closest('div[class],form,section,[class*="toolbar"],[class*="footer"],[class*="bottom"]');
        if (!container) container = input.parentElement?.parentElement;
        if (!container) return null;
        let btns = container.querySelectorAll('button');
        for (let b of btns) {
            if (!b.disabled && b.offsetParent) return b;
        }
        return null;
    }

    function fillReply(text) {
        const input = findInputBox();
        if (!input) { console.error('[飞鸽AI助手] 找不到输入框'); return false; }
        input.focus();
        if (input.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            input.textContent = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        console.log('[飞鸽AI助手] 回复已填入');
        return true;
    }

    function clickSend() {
        let btn = findSendBtn();
        if (btn && !btn.disabled) { btn.click(); console.log('[飞鸽AI助手] 已点击发送按钮'); return true; }
        let input = findInputBox();
        if (input) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            console.log('[飞鸽AI助手] 已模拟Enter发送');
            return true;
        }
        return false;
    }

    function showNotification(text) {
        let d = document.createElement('div');
        d.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;background:#1a1a2e;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,0.3);line-height:1.6;border-left:4px solid #4fc3f7;';
        d.textContent = text;
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 5000);
    }

    // ========== 网络通信 ==========
    function reportMessage(msgData) {
        GM_xmlhttpRequest({
            method: 'POST', url: BRIDGE_URL + '/message',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(msgData),
            onload: r => console.log('[飞鸽AI助手] 消息已上报'),
            onerror: () => console.warn('[飞鸽AI助手] 上报失败')
        });
    }

    function pollReply() {
        GM_xmlhttpRequest({
            method: 'GET', url: BRIDGE_URL + '/pending',
            onload: function(resp) {
                try {
                    let data = JSON.parse(resp.responseText);
                    if (data.status === 'has_reply' && data.reply) {
                        console.log('[飞鸽AI助手] AI回复:', data.reply.substring(0,60));
                        let filled = fillReply(data.reply);
                        if (filled) sentMessages.add(data.reply.substring(0, 80));
                        if (filled && data.auto_send) {
                            setTimeout(() => clickSend(), 300);
                        } else if (filled) {
                            showNotification(`AI建议回复（${data.risk_level==='high'?'⚠高风险请确认':'已填入输入框'}）`);
                        }
                    }
                } catch(e) {}
            }
        });
    }

    // ========== 消息监听（通用策略） ==========
    function observeMessages() {
        // 尝试在可能的消息容器上挂 MutationObserver
        // 策略：监听整个 body，但过滤只处理新增的、包含文本的 div/span
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    
                    // 获取节点内所有文本
                    let text = (node.textContent || '').trim();
                    if (text.length < 3 || text.length > 1000) continue;
                    if (text === lastProcessedMsg || processingMsg.has(text)) continue;

                    // 过滤：排除纯数字、纯链接
                    if (/^[\d\s,.]+$/.test(text)) continue;

                    // 排除自己发出的消息，防止回环
                    let isSelfSent = false;
                    for (let sm of sentMessages) {
                        if (text.includes(sm) || sm.includes(text)) { isSelfSent = true; break; }
                    }
                    if (isSelfSent) continue;
                    
                    processingMsg.add(text);
                    lastProcessedMsg = text;

                    let msgData = {
                        message_text: text,
                        customer_name: '',
                        order_ids: extractOrderIds(text),
                        intent: extractIntent(text),
                        timestamp: new Date().toISOString(),
                        page_url: window.location.href,
                    };
                    
                    console.log('[飞鸽AI助手] 新消息:', text.substring(0,80));
                    reportMessage(msgData);
                    setTimeout(() => processingMsg.delete(text), 5000);
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
        console.log('[飞鸽AI助手] 全局消息监听已启动');
    }

    // ========== 初始化 ==========
    function init() {
        // 先探测 DOM
        setTimeout(probeDOM, 1500);

        // 同时启动全局监听（兜底）
        setTimeout(observeMessages, 3000);

        // 轮询 AI 回复
        setInterval(pollReply, POLL_INTERVAL);

        // 定期重新探测（SPA 页面切换）
        setInterval(() => {
            if (document.querySelectorAll('textarea').length > 0 && !SELECTORS.inputBox) {
                probeDOM();
            }
        }, 15000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();