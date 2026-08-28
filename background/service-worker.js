/**
 * BILIBAN Background Service Worker
 *
 * 职责：
 *  1. 监听存储变化，通知所有 bilibili.com 标签页刷新
 *  2. 评论爬取扫描的调度中枢：接收管理页指令 (start/stop/status)，
 *     在后台发起分页请求、执行黑名单匹配，并将进度/结果实时推送给管理页
 */

importScripts('comment-crawler.js');

// ==================== 存储变更 → 广播刷新 ====================

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.biliban_blacklist) {
    // 通知所有 bilibili.com 标签页
    chrome.tabs.query({ url: '*://*.bilibili.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'refresh' }).catch(() => {});
      }
    });
  }
});

// ==================== 评论扫描消息路由 ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('BILIBAN_SCAN_')) {
    return; // 不处理与扫描无关的消息
  }

  if (msg.type === 'BILIBAN_SCAN_START') {
    BilibanCrawler.startScan(msg.videoRef, msg.options).then(sendResponse);
    return true; // 异步响应
  }

  if (msg.type === 'BILIBAN_SCAN_STOP') {
    BilibanCrawler.stopScan().then(sendResponse);
    return true;
  }

  if (msg.type === 'BILIBAN_SCAN_STATUS') {
    BilibanCrawler.getStatus().then(sendResponse);
    return true;
  }

  if (msg.type === 'BILIBAN_SCAN_RESET') {
    BilibanCrawler.resetState().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// ==================== 安装时初始化 ====================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[BILIBAN] 插件已安装/更新', details.reason);
  chrome.storage.local.get('biliban_blacklist', (result) => {
    if (!result.biliban_blacklist) {
      chrome.storage.local.set({
        biliban_blacklist: { groups: [] }
      });
      return;
    }
    // 安装/更新时自动清理分组内重复 UID，并将所有 UID 规范化为 Number
    const data = result.biliban_blacklist;
    let cleaned = 0;
    for (const group of (data.groups || [])) {
      const seen = new Set();
      const unique = [];
      for (const uid of group.uids) {
        const uidNum = Number(uid);
        if (isNaN(uidNum) || seen.has(uidNum)) { cleaned++; continue; }
        seen.add(uidNum);
        unique.push(uidNum);
      }
      group.uids = unique;
    }
    if (cleaned > 0) {
      chrome.storage.local.set({ biliban_blacklist: data });
      console.log('[BILIBAN] 自动去重：清理 ' + cleaned + ' 个重复/无效 UID');
    }
  });
});