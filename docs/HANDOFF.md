# 交接记录：已完成（v0.2.0）

> 2026-08-18 更新：**核心 + 全部打磨均已完成并在真实账号验证**。
> 当前插件在 9223 Chrome（`--user-data-dir=reverse/chrome-profile-plug --load-extension=plugin`）持续运行中。
> 新会话/便宜模型如需改动，直接看「可扩展方向」；别改稳定接口签名（见各文件顶部注释）。

## 当前运行状态（真机验证 ✅）

- 引擎：DeepSeek `deepseek-v4-flash`（key 存 chrome.storage，仅 background 使用），autoSend=on
- 门禁：每条消费者新消息开启一轮，轮内最多回 1 条（popup 可调 1-3），下条新消息重置额度
- 防重复三层：只回真人（平台卡片/机器人 role=4 过滤）＋ 内容指纹去重(60s) ＋ 发送锁+队列（同一会话串行处理）
- 输出清洗：剥【…】角色标签、`**`→“”、清 markdown 符号
- 灵活推理：知识库无直接答案时，按多条知识关联＋商业逻辑做有依据推断；无依据不编造
- 对话保存：买家/AI/人工客服 往来自动存 chrome.storage（chatlog，限 3000 条）；popup「导出 JSON」下载到下载目录
- 事件日志：background 持久化最近 100 条，popup 打开回显历史
- popup 状态显示：读真实 storage + tabs 探测，显示「自动回复已开启 · 自动发送 / 页面已连接」与实际一致
- 知识库：31 条（店铺/套餐价格明细/设施规则/推荐逻辑/私域），见 `docs/知识库.md`

## 已完成能力（全部真机验证 ✅）

- 转人工（`allocated_service`）判定 → 接管；未关闭会话自动接管
- 收买家消息 → 上下文(角色区分 buyer/aiSelf/staff/system，丢弃事件) → LLM → 真人延迟 → `sendText` 发送
- 免打扰 / 每日上限 / 同会话最小间隔(不足延后不丢) / 会话关闭退出 / 防回环
- 历史重推防护：启动前旧消息不回（防刷新连发）
- popup 面板：总开关/供应商+Key+模型+温度/自动发送/人设/知识库/真人化策略(间隔+每轮条数+每日上限+免打扰)/事件日志/对话记录导出/测试接管
- 后台 LLM fetch：OpenAI 兼容，内置 deepseek/openai/moonshot/zhipu/qwen/volc/siliconflow/openrouter，Key 仅存后台
- 配置持久化：ISOLATED host-bridge 读 chrome.storage → 下发 MAIN（MAIN 无法访问 chrome.*）

## 知识库重点（31 条，详见 docs/知识库.md）

- 店铺：【店铺名称】；【店铺地址】；【联系电话/微信号】
- 营业 9:30-20:00；1.2m 以下儿童免费；可带宠物(人宠水域分离)；可自带酒水；有冷饮/冰西瓜/小吃
- 8 个在售套餐：价格/内容/已售 全部录入
- 遮阳伞=帐篷；烧烤套餐含(不另收费)、玩水票视空位
- 按人数推荐：最大档套餐+补差额单人水票（14→10人套餐388+4张水票29.9×4）
- 入园规则：未购票不入园；正当理由(考察团建)工作人员陪同可进；白嫖理由不行
- 大型团建(三四十人+)→ 引私域 VX 【微信号】、价格可谈

## 可扩展方向（未做，按需）

- 图片消息识别（当前只回文本；`messageType/image` 需 `sendImageMessage` + 上传）
- 自动定时导出 chatlog（当前手动「导出 JSON」）
- 多账号/多页面 store 连接（当前单页足够）
- 敏感词/风险话术发送前告警（popup 已留 `acceptPreview` 位）
- 打包成正式 .crx 脱离调试端口长期运行（当前依赖 9223 开发者模式）

## 运维要点（用户需知）

- 保持 9223 Chrome + 客服台页面开着才工作；别登出、别关开发者模式、别移除扩展
- 电脑别长时间深度睡眠（睡眠期间消息不即时回）
- 更新插件代码后必须重载扩展本体（chrome.runtime.reload 或扩展管理页刷新），仅刷页面不够
- Key 只放 chrome.storage；不要提交任何真实密钥到仓库

## 测试

```
cd plugin/tests && node agent-gate.test.mjs   # 门禁 9 项（历史/双推/角色/指纹/锁）
node background-chat.test.mjs                  # 后台 chat 4 项
```
