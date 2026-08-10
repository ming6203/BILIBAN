/**
 * BILIBAN Background Service Worker
 * 监听存储变化，通知 content script 刷新
 */

// 当 Popup 修改了存储后，通知所有标签页刷新
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

// 安装时初始化
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
