# 抖音来客「转人工后 AI 接管」目标拆解：难点分级

> 状态写作时间：2026-08-18。本文档供「先做难的部分」的强模型照此执行难关，并把「容易的部分」留给后续便宜模型。

## 0. 一句话目标

用户（商家）在抖音来客飞鸽客服页面登录后，当买家会话变成「已分配人工客服」（转人工/`allocated_service`）时，由插件接管：实时监听买家消息 → 调 AI 生成像真人的人话 → 用 **页面自身的 IM SDK** 直接发送回复。全程不用模拟敲键盘/点按钮。

## 1. 已实锤的关键事实（live store 里验证过）

| 事实 | 值 | 影响 |
|---|---|---|
| 客服页应用宿主 | `window.Garfish.apps.cs_web.global` | 拿 store 的入口 |
| 全局聊天 store | `...global._chatStore`（MobX） | 数据源 |
| IM SDK store | `..._chatStore._imSdkStore` | 收发消息的钥匙 |
| 发文本 | `_imSdkStore.sendText(pigeonBizType, conversationId, content, bizExt?)` | 原生发送，不走 DOM |
| 收消息订阅 | `_imSdkStore.onMessage(fn)` / `onMessageUpsert(fn)` | 实时监听 |
| SDK 还提供 | `onConversationsChange / onConversationChange / onWsClosed / pullConversationList / getMessagesByConversation / markConversationRead / sendImageMessage / transferConversation` | 拓展能力 |
| 会话列表 | `_conversationStore.totalContacts` / `currentContacts`（MobX map） | 遍历会话、找目标会话 |
| 转人工事件 | 消息 `pigeonMsgType === "allocated_service"`，`originExt.is_allocated_event === "1"`，文案「新用户进线咨询，请及时回复」 | **接管判据（闸门）** |
| 消息角色 | `senderRole`：1=用户/买家，2=商家客服，3=系统；`isFromMe` 区分己方 | 过滤「要回谁」 |
| 会话关闭 | `conversation.rawConversation.closed` 或消息 `type=close_conversation`（「用户超时未回复，系统关闭会话」/「客服关闭会话」） | 停止接管的开关 |
| 页面内发请求 | `/napi/...?a_bogus=...` + `x-secsdk-csrf-token` | 只用 partial、不需要破解 |

## 2. 难度评级总览

| # | 任务 | 难度 | 完成状态 | 谁做 |
|---|---|---|---|---|
| 1 | 进页面拿到 `_chatStore` 和 `_imSdkStore`（含 Garfish 沙箱、时序等待、MobX 探针） | 难（已攻克） | ✅ 已写探针 `reverse/cdp/` | 已完成 |
| 2 | store 对应关系摸清（Contacts/服务/用户/消息/关闭语义） | 难（已攻克） | ✅ 已实锤 | 已完成 |
| 3 | 区分「机器人阶段 vs 人工接管阶段」的判据 | 难（已攻克） | ✅ `allocated_service` | 已完成 |
| 4 | 不模拟点击地原生发送 & 防回环 | 难（架构已定，代码待接） | 🔶 桥已写好待联 | 本会话 |
| 5 | 它把消息塞给 AI 的「桥」（content script ↔ 主进程/云端） | 难 | 🔶 桥已写好待联 | 本会话 |
| 6 | AI 回复「像真人」的话术引擎（人设/改写/延迟） | 中难 | ⬜ 待做 | 便宜模型 |
| 7 | 会话级上下文组装 + 免打扰/闸门规则 | 中 | ⬜ 待做 | 便宜模型 |
| 8 | 知识库/快捷语料注入 | 中 | ⬜ 待做 | 便宜模型 |
| 9 | 插件 UI（popup/开关/状态面板/会话面板） | 易 | ⬜ 待做 | 便宜模型 |
| 10 | 打包与加载（MV3 / 开发者模式） | 易 | ⬜ 待做 | 便宜模型 |
| 11 | 旁路：解释/解读买家消息、聚合统计 | 易 | ⬜ 待做 | 便宜模型 |

## 3. 为什么「插件直接调用页面 SDK」是正解（难点已解）

- 不依赖 DOM 选择器 → 不受页面改版影响（比用户脚本的 MutationObserver 稳）。
- 不需要 `a_bogus` / 签名 / 模拟登录 → 因为不自己做 HTTP 请求，借的是已登录页面内的 SDK。
- 转人工判据是结构化的协议消息（`allocated_service`），不是猜文案。

## 4. 留给便宜模型的「容易清单」将在 `docs/HANDOFF.md` 详述

- 具体接入点、代码骨架位置、各文件职责见交接文档。
- 原则：新模型照做即可，不需要重跑逆向。

## 5. 边界与安全注释

- 插件只在用户已登录、已打开客服页的浏览器里跑，复用用户自己的会话做合法客服操作。
- 不绕过登录/验证码；不提取或外发任何密钥/凭证。
- 只回答"如何用页面已有能力 + 公开 LLM API 实现自动客服"，不涉及任何对抗性破解。
