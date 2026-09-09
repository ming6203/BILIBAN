/**
 * BILIBAN Stats Collector v1
 * 黑名单使用情况数据采集：评论/视频命中屏蔽时记录事件。
 * - 内存缓冲 + 批量刷盘（累积 N 条或定时兜底；空缓冲不写入）
 * - 视频命中去重：同一视频同一 uid 只计首次（bvid_uid 会话级集合）
 * - 写入 chrome.storage.local 的 biliban_block_events
 */

(function() {
  'use strict';

  const EVENTS_KEY = 'biliban_block_events';
  const ADV_SETTINGS_KEY = 'biliban_advanced_settings';

  // 默认高级设置（与 manage 页保持一致）
  const DEFAULT_ADV = {
    flushBatch: 50,          // 累积条数刷盘
    flushInterval: 10,       // 秒；缓冲非空才兜底刷盘
    eventLimitMode: 'size', // 数据面板限制模式：count | size（默认大小形式）
    maxEvents: 50000,        // 数量模式：events 明细最大条数
    maxEventsMB: 8,          // 大小模式：事件数据存储上限 MB
    overflowStrategy: 1,     // 超额策略：1=淘汰最早(默认) 2=停止记录 3=清空明细只留曲线
    byteWarnPct: 90,         // 告警百分比（数量/大小模式共用）
    archiveMergeMB: 5,          // 归档分块阈值（MB）
    archiveCleanPct: 50,        // 手动清理比例（%）
    archiveAutoClean: false,    // 自动清理开关
    recordComment: true,     // 记录评论命中
    recordVideo: true,       // 记录视频命中
    recordSubtitle: false,   // 弹幕命中（预留）
    saveVideoTitle: false,   // 视频标题（仅展示，非去重键）
    keepUidDetail: true
  };

  let config = Object.assign({}, DEFAULT_ADV);
  let pending = [];            // 待刷盘缓冲
  let flushTimer = null;
  let seenVideos = new Set();  // 会话级视频命中去重（bvid_uid）
  let lastFlushAt = 0;

  // 从当前页面 URL 提取 bvid（视频页 /watch/ 路径）
  function currentBvid() {
    try {
      const m = location.href.match(/\/video\/(BV[0-9A-Za-z]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  // 读高级设置（失败用默认）
  async function loadConfig() {
    try {
      const r = await chrome.storage.local.get(ADV_SETTINGS_KEY);
      const s = r[ADV_SETTINGS_KEY];
      if (s) config = Object.assign({}, DEFAULT_ADV, s);
    } catch (e) { /* 默认 */ }
  }

  // 写 storage（批量：读-合并-写）
  async function flush() {
    if (pending.length === 0) return;   // 空缓冲不产生写入
    const batch = pending;
    pending = [];
    try {
      const r = await chrome.storage.local.get(EVENTS_KEY);
      let data = r[EVENTS_KEY] || { events: [], aggregates: {}, buckets: {} };
      let events = data.events || [];

      const now = Date.now();
      for (const ev of batch) {
        events.push(ev);
        // 同步维护按天 time-bucket（供频率曲线，最省空间的兜底数据）
        const d = new Date(ev.timestamp || now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        data.buckets = data.buckets || {};
        data.buckets[dayKey] = (data.buckets[dayKey] || 0) + 1;
        // 按类型分别维护（供折线图分线）
        const bKey = ev.type === 'video' ? 'videoBuckets' : 'commentBuckets';
        data[bKey] = data[bKey] || {};
        data[bKey][dayKey] = (data[bKey][dayKey] || 0) + 1;
      }

      // 配额控制：数量模式按 events 条数，大小模式按字节估算；配额 0 = 不限制；超限按策略处理
      let overLimit = false;
      if (config.eventLimitMode === 'size') {
        // 大小模式：估算事件数据字节（UTF-8 粗略：长度*2 或 JSON 序列化长度）
        const limitMB = config.maxEventsMB != null ? config.maxEventsMB : DEFAULT_ADV.maxEventsMB;
        if (limitMB > 0) {
          const bytesEstimate = events.length ? JSON.stringify(events).length * 2 : 0;
          const limitBytes = limitMB * 1024 * 1024;
          if (bytesEstimate > limitBytes) overLimit = true;
        }
      } else {
        if (config.maxEvents > 0 && events.length > config.maxEvents) overLimit = true;
      }
      if (overLimit) {
        if (config.overflowStrategy === 2) {
          // 策略 2：停止记录——配额满后不再写入新事件，旧数据完整保留；打标记供数据面板提示
          data.meta = data.meta || {};
          data.meta.quotaStoppedAt = Date.now();
          await chrome.storage.local.set({ [EVENTS_KEY]: data });
          return;
        } else if (config.overflowStrategy === 3) {
          // 策略 3：清空明细只留曲线（buckets 计数保留）
          events = [];
        } else {
          // 策略 1（默认）：淘汰最早——裁剪到配额内，曲线保留
          if (config.eventLimitMode === 'size') {
            const limitMB = config.maxEventsMB != null ? config.maxEventsMB : DEFAULT_ADV.maxEventsMB;
            const limitBytes = limitMB * 1024 * 1024;
            while (events.length > 1 && JSON.stringify(events).length * 2 > limitBytes) {
              events.shift();
            }
          } else {
            const over = events.length - config.maxEvents;
            events = events.slice(over);
          }
          // 淘汰策略下配额恢复正常，清除停止记录标记
          if (data.meta && data.meta.quotaStoppedAt) delete data.meta.quotaStoppedAt;
        }
      } else if (data.meta && data.meta.quotaStoppedAt) {
        // 配额未超限 → 已恢复记录，清除停止标记
        delete data.meta.quotaStoppedAt;
      }

      // ---- 按天 time-bucket 计数已在上方随 events 维护（buckets 永不清理，曲线数据源） ----
      // ---- 聚合表已移除（不再维护 bvid+uid 统计） ----

      data.events = events;
      data.meta = data.meta || {};
      data.meta.lastSynced = now;
      await chrome.storage.local.set({ [EVENTS_KEY]: data });
    } catch (e) { /* 写失败不阻塞页面 */ }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().finally(() => { lastFlushAt = Date.now(); });
    }, config.flushInterval * 1000);
  }

  // 对外接口：记录一次屏蔽命中
  // type: 'comment' | 'video'
  // ctx: { uid, videoBvid?, videoTitle?, groupId? }
  async function collectBlockEvent(type, uid, ctx) {
    ctx = ctx || {};
    try {
      if (type === 'comment' && !config.recordComment) return;
      if (type === 'video' && !config.recordVideo) return;
      if (!uid) return;

      const bvid = ctx.videoBvid || currentBvid();
      // 视频命中去重：同一视频同一 uid 只计首次
      if (type === 'video') {
        if (!bvid) return;   // 无 bvid 无法去重，跳过视频计数
        const key = bvid + '_' + uid;
        if (seenVideos.has(key)) return;
        seenVideos.add(key);
      }

      pending.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        type: type,
        uid: uid,
        groupId: ctx.groupId || '',
        videoBvid: bvid,
        videoTitle: config.saveVideoTitle ? (ctx.videoTitle || '') : '',
        timestamp: Date.now()
      });

      // 累积满 N 条立即刷盘
      if (pending.length >= config.flushBatch) {
        clearTimeout(flushTimer);
        flushTimer = null;
        flush().finally(() => { lastFlushAt = Date.now(); });
      } else {
        scheduleFlush();
      }
    } catch (e) { /* 采集失败不影响主功能 */ }
  }

  // 监听高级设置变更（热更新）
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[ADV_SETTINGS_KEY]) {
        const s = changes[ADV_SETTINGS_KEY].newValue;
        if (s) config = Object.assign({}, DEFAULT_ADV, s);
      }
    });
  }

  // 页面卸载前兜底刷盘
  try {
    window.addEventListener('pagehide', () => { flush(); });
  } catch (e) { /* 忽略 */ }

  // 暴露接口给 bilibili.js（isolated world 共享）
  window.__BILIBAN_STATS__ = {
    collectBlockEvent: collectBlockEvent,
    collectComment: (uid, ctx) => collectBlockEvent('comment', uid, ctx),
    collectVideo: (uid, ctx) => collectBlockEvent('video', uid, ctx),
    getPending: () => pending.length
  };

  loadConfig();
})();
