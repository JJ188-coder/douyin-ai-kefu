// knowledge.js — 知识库 / 话术库（MAIN world）
// 内置一份通用商家客服话术模板；用户可在 popup 里追加自定义问答。
(() => {
  'use strict';

  const BUILTIN = [
    '问：在线吗/能回复吗？答：您好，我在的，有什么可以帮您～',
    '问：什么时候发货？答：亲，下单后 48 小时内安排发货，发货后会第一时间同步物流单号给您。',
    '问：多久能收到？答：一般发出后 1-3 天送达，具体以物流信息为准哈。',
    '问：怎么退款/想退货？答：亲，您可以在订单页面申请售后/退款，或把订单号发我，我帮您查一下处理。',
    '问：还没收到货。答：我帮您查一下物流，如果是运输异常会尽快帮您联系处理，请稍等哈。',
    '问：能优惠吗/能不能便宜点？答：亲，现在这款正好有活动价呢，这个价格已经是很实在的了～',
    '问：有质量问题/bad评论。答：非常抱歉给您带来不好的体验，质量问题我们一定负责到底，您把照片/订单号发我，我尽快帮您处理。',
    '问：可以开发票吗？答：可以开的，下单后把开票信息发我即可。',
  ];

  const api = {
    defaults: () => BUILTIN.slice(),
    merge: (custom) => {
      const list = Array.isArray(custom) && custom.length ? custom : [];
      return [...BUILTIN, ...list.map((s) => (typeof s === 'string' ? s : '')).filter(Boolean)];
    },
  };
  window.__knowledge = api;
  console.log('[knowledge] ready; builtin lines:', BUILTIN.length);
  return api;
})();
