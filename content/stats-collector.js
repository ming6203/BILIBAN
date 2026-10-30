/**
 * BILIBAN Stats Collector v3
 * 黑名单使用情况数据采集：只记录屏蔽发生的时间与类型。
 * - 不记录 UID / BV 号 / 标题 / 分组等明细
 * - video / comment 两个时间戳数组（见 lib/storage.js）
 * - 固定批量刷盘：20 条或 1 秒；页面隐藏/卸载时兜底刷盘
 * - 通过 service worker 串行写入，避免多标签页同时读改写导致丢数据
 */

(function() {
  'use strict';

  const BATCH_SIZE = 20;
  const FLUSH_INTERVAL_MS = 1000;
  const MAX_DEFERRED = 500;
  const MAX_API_EVENTS_PER_MESSAGE = 1000;

  let config = { recordComment: true, recordVideo: true };
  let configReady = false;
  let deferred = [];            // 设置读取完成前的短暂缓冲
  let pendingVideo = [];
  let pendingComment = [];
  let flushTimer = null;
  let writeError = false;

  function storage() {
    return (typeof BilibanStorage !== 'undefined') ? BilibanStorage : null;
  }

  function applyConfig(saved) {
    if (!saved || typeof saved !== 'object') return;
    config = {
      recordComment: saved.recordComment !== false,
      recordVideo: saved.recordVideo !== false
    };
  }

  async function loadConfig() {
    const s = storage();
    if (!s) {
      configReady = true;
      drainDeferred();
      return;
    }
    try {
      const saved = await s.getAdvancedSettings();
      applyConfig(saved);
      if (typeof s.getBlockWriteError === 'function') {
        writeError = !!(await s.getBlockWriteError());
      }
    } catch (e) {
      /* 使用默认值 */
    } finally {
      configReady = true;
      drainDeferred();
    }
  }

  // 设置读取完成前先暂存，完成后再按开关过滤，避免开局事件被直接丢弃
  function drainDeferred() {
    if (!configReady || deferred.length === 0) return;
    const list = deferred;
    deferred = [];
    for (const item of list) {
      collectBlockEvent(item.type, item.uid, item.ctx, true);
    }
  }

  // 优先交给 service worker 串行写入；消息通道失败时回退到直接写 storage
  async function persist(video, comment) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'BILIBAN_STATS_APPEND',
          video: video,
          comment: comment
        });
        if (resp && resp.ok) return;
        if (resp && resp.error) throw new Error(resp.error);
      } catch (e) {
        /* 回退到本地直接写 */
      }
    }

    const s = storage();
    if (!s || typeof s.appendBlockEvents !== 'function') {
      throw new Error('存储模块未加载');
    }
    await s.appendBlockEvents(video, comment);
  }

  async function flush() {
    if (pendingVideo.length === 0 && pendingComment.length === 0) return;

    const video = pendingVideo;
    const comment = pendingComment;
    pendingVideo = [];
    pendingComment = [];

    try {
      await persist(video, comment);
      if (writeError) {
        writeError = false;
        const s = storage();
        if (s && typeof s.clearBlockWriteError === 'function') {
          try { await s.clearBlockWriteError(); } catch (e) { /* 忽略 */ }
        }
      }
    } catch (e) {
      writeError = true;
      const s = storage();
      if (s && typeof s.setBlockWriteError === 'function') {
        try { await s.setBlockWriteError(e && e.message ? e.message : '写入失败'); } catch (e2) { /* 忽略 */ }
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }

  function queueFlushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
  }

  // 记录一次屏蔽命中；uid 仅用于调用方语义，不写入存储
  function collectBlockEvent(type, uid, ctx, bypassGate) {
    ctx = ctx || {};
    try {
      if (!configReady && !bypassGate) {
        if (deferred.length < MAX_DEFERRED) deferred.push({ type: type, uid: uid, ctx: ctx });
        return;
      }
      if (type === 'comment' && !config.recordComment) return;
      if (type === 'video' && !config.recordVideo) return;

      const timestamp = Date.now();
      if (type === 'video') pendingVideo.push(timestamp);
      else pendingComment.push(timestamp);

      if (pendingVideo.length + pendingComment.length >= BATCH_SIZE) {
        queueFlushNow();
      } else {
        scheduleFlush();
      }
    } catch (e) { /* 采集失败不影响主功能 */ }
  }

  // interceptor（MAIN world）通过 postMessage 上报 API 层过滤掉的条目
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'BILIBAN_BLOCK_EVENT') return;

    const type = data.kind === 'video' ? 'video' : 'comment';
    let count = Number(data.count);
    if (!Number.isFinite(count) || count <= 0) return;
    count = Math.min(MAX_API_EVENTS_PER_MESSAGE, Math.floor(count));
    for (let i = 0; i < count; i++) collectBlockEvent(type, 0, {});
  });

  // 监听记录开关变更（热更新）
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.biliban_advanced_settings) {
        applyConfig(changes.biliban_advanced_settings.newValue);
      }
    });
  }

  // 页面隐藏/卸载前兜底刷盘
  try {
    window.addEventListener('pagehide', () => { flush(); });
    window.addEventListener('beforeunload', () => { flush(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  } catch (e) { /* 忽略 */ }

  // 暴露接口给 bilibili.js（isolated world 共享）
  window.__BILIBAN_STATS__ = {
    collectBlockEvent: collectBlockEvent,
    collectComment: (uid, ctx) => collectBlockEvent('comment', uid, ctx),
    collectVideo: (uid, ctx) => collectBlockEvent('video', uid, ctx),
    getPending: () => pendingVideo.length + pendingComment.length
  };

  // 通知 MAIN world 拦截器：接收端已就绪，可以刷新早期缓存的事件
  try { window.postMessage({ type: 'BILIBAN_STATS_READY' }, '*'); } catch (e) { /* 忽略 */ }

  loadConfig();
})();
