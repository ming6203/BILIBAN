/**
 * BILIBAN API 拦截器 (MAIN world)
 * document_start 运行，拦截 fetch/XHR，在渲染前过滤被屏蔽用户
 */

(function() {
  'use strict';

  var blockedUids = new Set();

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
      if (data.data.replies.length !== before) modified = true;
    }
    if (data.data && data.data.top_replies) {
      data.data.top_replies = data.data.top_replies.filter(function(r) {
        return !blockedUids.has(Number(r.member && r.member.mid || r.mid));
      });
    }
    if (data.data && data.data.item) {
      var before2 = data.data.item.length;
      data.data.item = data.data.item.filter(function(item) {
        return !blockedUids.has(Number(item.owner && item.owner.mid || item.mid));
      });
      if (data.data.item.length !== before2) modified = true;
    }
    if (data.data && data.data.result) {
      var before3 = data.data.result.length;
      data.data.result = data.data.result.filter(function(item) {
        return !blockedUids.has(Number(item.mid));
      });
      if (data.data.result.length !== before3) modified = true;
    }
    if (data.data && data.data.items) {
      data.data.items = data.data.items.filter(function(item) {
        return !blockedUids.has(Number(item.modules && item.modules.module_author && item.modules.module_author.mid || item.uid));
      });
    }
    return modified;
  }
})();
