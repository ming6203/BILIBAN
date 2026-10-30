/**
 * BILIBAN API 拦截器 (MAIN world)
 * document_start 运行，拦截 fetch/XHR，在渲染前过滤被屏蔽用户
 * 过滤掉的条目通过 BILIBAN_BLOCK_EVENT 上报给数据面板采集器
 */

(function() {
  'use strict';

  var blockedUids = new Set();

  // API 层过滤事件先缓存，等 isolated world 的统计采集器就绪后再发送，
  // 避免 document_start 阶段过滤的数据因为接收端尚未加载而丢失。
  var statsBuffer = [];
  var statsReady = false;
  var MAX_STATS_BUFFER = 5000;

  function postBlockEvent(kind, count) {
    try {
      window.postMessage({
        type: 'BILIBAN_BLOCK_EVENT',
        kind: kind,
        count: count
      }, '*');
    } catch (e) { /* 忽略 */ }
  }

  function reportBlocked(kind, count) {
    if (!count || count < 1) return;
    if (statsReady) {
      postBlockEvent(kind, count);
    } else if (statsBuffer.length < MAX_STATS_BUFFER) {
      statsBuffer.push({ kind: kind, count: count });
    }
  }

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.type !== 'BILIBAN_STATS_READY') return;
    statsReady = true;
    var pending = statsBuffer;
    statsBuffer = [];
    for (var i = 0; i < pending.length; i++) {
      postBlockEvent(pending[i].kind, pending[i].count);
    }
  });

  function initFromStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('biliban_blacklist', function(result) {
        var data = result.biliban_blacklist;
        if (data && data.groups) {
          var uidSet = new Set();
          for (var i = 0; i < data.groups.length; i++) {
            var group = data.groups[i];
            if (group.enabled !== false) {
              (group.uids || []).forEach(function(uid) { uidSet.add(uid); });
            }
          }
          blockedUids = uidSet;
          console.log('[BILIBAN] 拦截器加载 ' + blockedUids.size + ' 个屏蔽 UID');
        }
      });
      chrome.storage.onChanged.addListener(function(changes, area) {
        if (area === 'local' && changes.biliban_blacklist) {
          var newValue = changes.biliban_blacklist.newValue;
          if (newValue && newValue.groups) {
            var uidSet = new Set();
            for (var i = 0; i < newValue.groups.length; i++) {
              var group = newValue.groups[i];
              if (group.enabled !== false) {
                (group.uids || []).forEach(function(uid) { uidSet.add(uid); });
              }
            }
            blockedUids = uidSet;
          }
        }
      });
    }
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'BILIBAN_UPDATE_UIDS') {
        blockedUids = new Set(event.data.uids);
      }
    });
  }
  initFromStorage();

  var originalFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    return originalFetch.apply(this, args).then(function(response) {
      try {
        var url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
        if (blockedUids.size > 0 && url.indexOf('bilibili') !== -1 && (url.indexOf('api.bilibili.com') !== -1 || url.indexOf('api.live.bilibili.com') !== -1)) {
          var cloned = response.clone();
          return cloned.text().then(function(text) {
            try {
              var data = JSON.parse(text);
              if (filterResponse(data)) {
                return new Response(JSON.stringify(data), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              }
            } catch(e) {}
            return response;
          });
        }
      } catch(e) {}
      return response;
    });
  };

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._biban_url = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      try {
        if (blockedUids.size === 0) return;
        var url = this._biban_url || '';
        if (url.indexOf('api.bilibili.com') === -1 && url.indexOf('api.live.bilibili.com') === -1) return;
        if (this.responseType !== '' && this.responseType !== 'text') return;
        var data = JSON.parse(this.responseText);
        if (filterResponse(data)) {
          var filtered = JSON.stringify(data);
          Object.defineProperty(this, 'responseText', { value: filtered, writable: false });
          Object.defineProperty(this, 'response', { value: filtered, writable: false });
        }
      } catch(e) {}
    });
    return originalSend.apply(this, arguments);
  };

  function filterResponse(data) {
    if (!data || blockedUids.size === 0) return false;
    var modified = false;
    if (data.data && data.data.replies) {
      var before = data.data.replies.length;
      data.data.replies = data.data.replies.filter(function(r) {
        return !blockedUids.has(Number(r.member && r.member.mid || r.mid));
      });
      var removed = before - data.data.replies.length;
      if (removed > 0) {
        modified = true;
        reportBlocked('comment', removed);
      }
    }
    if (data.data && data.data.top_replies) {
      var beforeTop = data.data.top_replies.length;
      data.data.top_replies = data.data.top_replies.filter(function(r) {
        return !blockedUids.has(Number(r.member && r.member.mid || r.mid));
      });
      var removedTop = beforeTop - data.data.top_replies.length;
      if (removedTop > 0) {
        modified = true;
        reportBlocked('comment', removedTop);
      }
    }
    if (data.data && data.data.item) {
      var before2 = data.data.item.length;
      data.data.item = data.data.item.filter(function(item) {
        return !blockedUids.has(Number(item.owner && item.owner.mid || item.mid));
      });
      var removed2 = before2 - data.data.item.length;
      if (removed2 > 0) {
        modified = true;
        reportBlocked('video', removed2);
      }
    }
    if (data.data && data.data.result) {
      var before3 = data.data.result.length;
      data.data.result = data.data.result.filter(function(item) {
        return !blockedUids.has(Number(item.mid));
      });
      var removed3 = before3 - data.data.result.length;
      if (removed3 > 0) {
        modified = true;
        reportBlocked('video', removed3);
      }
    }
    if (data.data && data.data.items) {
      var before4 = data.data.items.length;
      data.data.items = data.data.items.filter(function(item) {
        return !blockedUids.has(Number(item.modules && item.modules.module_author && item.modules.module_author.mid || item.uid));
      });
      var removed4 = before4 - data.data.items.length;
      if (removed4 > 0) {
        modified = true;
        reportBlocked('video', removed4);
      }
    }
    return modified;
  }
})();
