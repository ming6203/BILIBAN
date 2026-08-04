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
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BILIBAN] 插件已安装');
  chrome.storage.local.get('biliban_blacklist', (result) => {
    if (!result.biliban_blacklist) {
      chrome.storage.local.set({
        biliban_blacklist: { groups: [] }
      });
    }
  });
});
