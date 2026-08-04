/**
 * BILIBAN Content Script v14
 * 按钮插入到用户名旁边，与 UP 主名字同行；Gate 直播页跳过屏蔽按钮
 */

(function() {
  'use strict';

  let blockedUids = new Set();
  let powerScanInterval = null;
  const DONE = '__biban_done';

  const CARD_SELECTORS = [
    '.bili-video-card',
    '.bilibili-gate-video-grid>[data-bvid].bili-video-card',
    '.bilibili-gate-video-grid>.bili-video-card',
    '.bili-video-card__wrap',
    '.video-page-card-small',
    '.video-page-card-small .bili-video-card',
    '.right-container .video-card',
    '.video-card',
    // BewlyBewly
    '.video-card.group'
  ].join(',');

  // 公共按钮样式（用于注入 Shadow DOM）
  const BLOCK_BTN_CSS = `.biliban-block-btn{display:inline-flex;align-items:center;padding:1px 6px;border:1px solid #ddd;border-radius:3px;background:#fafafa;color:#999;font-size:10px;cursor:pointer;transition:all 0.15s;vertical-align:middle;line-height:1.2;flex-shrink:0;white-space:nowrap}
.biliban-block-btn:hover{background:#ff4d4f;color:white;border-color:#ff4d4f}
.biliban-no-wrap{display:inline-flex!important;align-items:center!important;gap:4px!important;flex-wrap:nowrap!important;white-space:nowrap!important}
:host(.dark) .biliban-block-btn{background:#3a3a3a;color:#bbb;border-color:#555}
:host(.dark) .biliban-block-btn:hover{background:#ff4d4f;color:white;border-color:#ff4d4f}`;

  function injectBlockBtnStyles(sr) {
    if (!sr || sr.querySelector('#biliban-block-btn-style')) return;
    const style = document.createElement('style');
    style.id = 'biliban-block-btn-style';
    style.textContent = BLOCK_BTN_CSS;
    sr.appendChild(style);
  }

  async function init() {
    blockedUids = await BilibanStorage.getBlockedUids();
    console.log('[BILIBAN] v14 已加载 ' + blockedUids.size + ' 个屏蔽 UID');
    syncUidsToInterceptor();

    new MutationObserver(() => scanAll()).observe(document.body, {
      childList: true, subtree: true
    });

    watchGateGrid();

    // Initial scan for elements already in DOM
    scanAll();
    setTimeout(scanAll, 500);
    setTimeout(scanAll, 1500);

    // Power mode: check saved state and listen for changes
    chrome.storage.local.get('biliban_power_mode', function(result) {
      if (result.biliban_power_mode) startPowerScan();
    });
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local' && changes.biliban_power_mode) {
        if (changes.biliban_power_mode.newValue) startPowerScan();
        else stopPowerScan();
      }
    });
  }

  function startPowerScan() {
    if (powerScanInterval) return;
    powerScanInterval = setInterval(function() { scanAll(); }, 500);
    console.log('[BILIBAN] 强力屏蔽模式已开启');
  }

  function stopPowerScan() {
    if (powerScanInterval) {
      clearInterval(powerScanInterval);
      powerScanInterval = null;
      console.log('[BILIBAN] 强力屏蔽模式已关闭');
    }
  }

  function watchGateGrid() {
    const check = () => {
      const grid = document.querySelector('.bilibili-gate-video-grid')
        || document.querySelector('.bewly-grid')
        || document.querySelector('[class*="bewly"]');
      if (grid) {
        new MutationObserver(() => scanAll()).observe(grid, {
          childList: true, subtree: true
        });
      }

      // Watch BewlyBewly Shadow DOM
      const sr = getBewlyShadowRoot();
      if (sr) {
        new MutationObserver(() => scanAll()).observe(sr, {
          childList: true, subtree: true
        });
      } else {
        setTimeout(check, 1000);
      }
    };
    check();
  }

  function syncUidsToInterceptor() {
    window.postMessage({ type: 'BILIBAN_UPDATE_UIDS', uids: [...blockedUids] }, '*');
  }


  // ==================== BewlyBewly Shadow DOM ====================

  function getBewlyShadowRoot() {
    // Try multiple selectors
    const selectors = ['.dark.disable-frosted-glass', '.disable-frosted-glass', '[class*="disable-frosted"]', '[class*="frosted-glass"]'];
    for (const sel of selectors) {
      const host = document.querySelector(sel);
      if (host && host.shadowRoot) {
        return host.shadowRoot;
      }
    }
    // Brute force: check all elements with shadowRoot
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        const cards = el.shadowRoot.querySelectorAll('.video-card');
        if (cards.length > 0) {
          console.log('[BILIBAN] Found Shadow DOM via brute force: ' + el.tagName + '.' + el.className.substring(0, 40) + ' cards=' + cards.length);
          return el.shadowRoot;
        }
      }
    }
    return null;
  }

  let _scanPending = false;
  function scanAll() {
    if (!document.body) return;
    if (_scanPending) return;
    _scanPending = true;
    requestAnimationFrame(() => {
      _scanPending = false;
      processComments();
      processVideoCards();
      processBewlyCards();
    });
  }


  // ==================== Shadow DOM 深度搜索 ====================

  function deepQuerySelector(root, selector) {
    let found = root.querySelector(selector);
    if (found) return found;
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        found = deepQuerySelector(el.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  // ==================== 评论区 ====================

  function processComments() {
    if (!document.querySelector('bili-comments')) return;
    const bc = document.querySelector('bili-comments');
    if (!bc || !bc.shadowRoot) return;

    bc.shadowRoot.querySelectorAll('bili-comment-thread-renderer').forEach(thread => {
      if (!thread.shadowRoot) return;

      // Skip thread if its main renderer is already done
      const renderer = thread.shadowRoot.querySelector('bili-comment-renderer');
      if (renderer && !renderer[DONE]) processCommentRenderer(renderer);

      const replies = thread.shadowRoot.querySelector('bili-comment-replies-renderer');
      if (!replies || !replies.shadowRoot) return;

      // Skip replies container if all reply renderers are done
      const replyRenderers = replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
      let hasPending = false;
      replyRenderers.forEach(r => {
        if (!r[DONE]) { hasPending = true; processReplyRenderer(r); }
      });
      if (!hasPending) return;
    });
  }



  function processCommentRenderer(renderer) {
    if (renderer[DONE]) return;
    const shadow = renderer.shadowRoot;
    if (!shadow) return;

    // Extract UID
    const avatarLink = shadow.querySelector('a[data-user-profile-id]');
    if (!avatarLink) return;
    const uid = Number(avatarLink.getAttribute('data-user-profile-id'));
    if (!uid) return;

    renderer[DONE] = true;

    if (blockedUids.has(uid)) {
      const thread = renderer.closest('bili-comment-thread-renderer');
      if (thread) { thread.remove(); return; }
      const body = shadow.querySelector('#body');
      if (body) body.remove();
      return;
    }

    // Place button next to username in bili-comment-user-info
    const userInfo = shadow.querySelector('bili-comment-user-info');

    // 检查按钮是否已存在（按钮可能在嵌套的 shadow DOM 中）
    if (deepQuerySelector(shadow, '.biliban-block-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'biliban-block-btn';
    btn.textContent = '屏蔽';
    btn.title = '屏蔽用户 ' + uid;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showGroupPicker(btn, uid); });
    if (userInfo && userInfo.shadowRoot) {
      injectBlockBtnStyles(userInfo.shadowRoot);
      const userName = userInfo.shadowRoot.querySelector('.user-name') || userInfo.shadowRoot.querySelector('a');
      if (userName) {
        const nameParent = userName.parentElement || userName;
        nameParent.classList.add('biliban-no-wrap');
        userName.after(btn);
        return;
      }
    }

    // Fallback: #header
    const header = shadow.querySelector('#header');
    if (header) {
      header.classList.add('biliban-no-wrap');
      header.appendChild(btn);
    }
  }

  // ==================== 回复评论 ====================

  function processReplyRenderer(renderer) {
    if (renderer[DONE]) return;
    const shadow = renderer.shadowRoot;
    if (!shadow) {
      if (!renderer._bibanRetry) {
        renderer._bibanRetry = true;
        setTimeout(() => processReplyRenderer(renderer), 200);
      }
      return;
    }

    // UID extraction
    let uid = null;
    const uidEl = shadow.querySelector('a[data-user-profile-id]');
    if (uidEl) uid = Number(uidEl.getAttribute('data-user-profile-id'));
    if (!uid) {
      const any = shadow.querySelector('[data-user-profile-id]');
      if (any) uid = Number(any.getAttribute('data-user-profile-id'));
    }
    if (!uid) return;

    renderer[DONE] = true;

    if (blockedUids.has(uid)) {
      const wrap = renderer.closest('bili-comment-reply-renderer') || renderer.parentElement;
      if (wrap) wrap.remove();
      return;
    }

    if (shadow.querySelector('.biliban-block-btn')) return;

    injectBlockBtnStyles(shadow);

    const btn = document.createElement('button');
    btn.className = 'biliban-block-btn';
    btn.textContent = '屏蔽';
    btn.title = '屏蔽用户 ' + uid;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showGroupPicker(btn, uid); });

    // Reply structure: #body > #main > bili-comment-user-info (shadow is empty)
    // Place button right after bili-comment-user-info in #main
    const userInfo = shadow.querySelector('bili-comment-user-info');
    if (userInfo) {
      userInfo.after(btn);
      return;
    }

    // Fallback: #header (for main comments that use this path)
    const header = shadow.querySelector('#header');
    if (header) {
      header.classList.add('biliban-no-wrap');
      header.appendChild(btn);
    }
  }

  // ==================== 视频卡片 ====================

  function processVideoCards() {
    let removed = false;
    const cards = document.querySelectorAll(CARD_SELECTORS);
    if (cards.length === 0) return;

    cards.forEach(card => {
      // Gate 直播页卡片：移除旧按钮，跳过注入
      if (card.classList.contains('bilibili-gate-video-card') && !card.querySelector('.bili-video-card__info--owner')) {
        card.querySelectorAll('.biliban-block-btn').forEach(b => b.remove());
        return;
      }
      if (card[DONE]) return;
      const uid = extractCardUid(card);
      if (!uid) return;
      card[DONE] = true;
      

      if (blockedUids.has(uid)) {
        removeCard(card);
        removed = true;
        return;
      }

      injectCardBlockBtn(card, uid);
    });

    if (removed) forceReflow();
  }

  function removeCardById(uid) {
    let removed = false;
    document.querySelectorAll(CARD_SELECTORS).forEach(card => {
      const cardUid = extractCardUid(card);
      if (cardUid === uid) {
        removeCard(card);
        removed = true;
      }
    });
    if (removed) forceReflow();
  }

  function removeCommentById(uid) {
    const bc = document.querySelector('bili-comments');
    if (!bc || !bc.shadowRoot) return;

    function removeThreadMatch(root) {
      root.querySelectorAll('bili-comment-thread-renderer').forEach(thread => {
        if (!thread.shadowRoot) return;
        const renderer = thread.shadowRoot.querySelector('bili-comment-renderer');
        if (renderer) {
          const link = deepQuerySelector(renderer.shadowRoot || document, '[data-user-profile-id]');
          if (link && Number(link.getAttribute('data-user-profile-id')) === uid) {
            thread.remove();
            return;
          }
        }
        // Check nested reply threads
        const replies = thread.shadowRoot.querySelector('bili-comment-replies-renderer');
        if (replies && replies.shadowRoot) {
          removeThreadMatch(replies.shadowRoot);
        }
      });
    }
    removeThreadMatch(bc.shadowRoot);
  }

  function removeCard(card) {
    const target = card.closest('[class*="col_"]')
      || card.closest('.video-page-card-small')
      || card.closest('.right-container')
      || card.parentElement;

    if (target && target !== document.body && !target.classList.contains('bilibili-gate-video-grid') && !target.classList.contains('bili-feed4') && !target.classList.contains('bewly-grid')) {
      target.remove();
    } else {
      card.remove();
    }
  }

  function forceReflow() {
    document.querySelectorAll('.video-list, .feed-card, [class*="feed-container"], [class*="gate-video-grid"], [class*="bewly-grid"], [class*="bewly-grid"], .video-page-card-small, .right-container').forEach(c => {
      void c.offsetHeight;
    });
    void document.body.offsetHeight;
  }

  function extractCardUid(el) {
    const spaceLink = el.querySelector('a[href*="space.bilibili.com"]');
    if (spaceLink) {
      const m = spaceLink.getAttribute('href').match(/space\.bilibili\.com\/(\d+)/);
      if (m) return Number(m[1]);
    }

    const gateOwner = el.querySelector('.bili-video-card__info--owner');
    if (gateOwner) {
      const href = gateOwner.getAttribute('href') || '';
      const m = href.match(/space\.bilibili\.com\/(\d+)/);
      if (m) return Number(m[1]);
    }

    const slashLink = el.querySelector('a[href*="/space/"]');
    if (slashLink) {
      const m = slashLink.getAttribute('href').match(/\/space\/(\d+)/);
      if (m) return Number(m[1]);
    }

    for (const attr of ['data-user-id', 'data-uid', 'data-mid', 'data-up-id', 'data-owner-id']) {
      const val = el.getAttribute(attr) || el.querySelector('[' + attr + ']')?.getAttribute(attr);
      if (val && /^\d+$/.test(val)) return Number(val);
    }

    return null;
  }

  function injectCardBlockBtn(container, uid) {
    if (container.querySelector('.biliban-block-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'biliban-block-btn';
    btn.textContent = '屏蔽';
    btn.title = '屏蔽用户 ' + uid;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showGroupPicker(btn, uid); });

    // BewlyBewly: 找 channel-name 链接
    const bewlyAuthor = container.querySelector('.channel-name');
    if (bewlyAuthor) {
      bewlyAuthor.parentElement.classList.add('biliban-no-wrap');
      bewlyAuthor.after(btn);
      return;
    }

    // 优先找 Bilibili-Gate 的 info--owner，把按钮插入到它内部
    const gateOwner = container.querySelector('.bili-video-card__info--owner');
    if (gateOwner) {
      // info--owner 是 inline 元素（<a>），按钮插入到其内部末尾
      gateOwner.appendChild(btn);
      return;
    }

    // 默认布局：找 info--bottom 中的 space 链接
    const upLink = container.querySelector('.bili-video-card__info--bottom a[href*="space.bilibili.com"]')
      || container.querySelector('a[href*="space.bilibili.com"]');

    if (upLink) {
      const nameArea = upLink.closest('.biliban-no-wrap') || upLink.parentElement;
      if (nameArea) {
        nameArea.classList.add('biliban-no-wrap');
      }
      upLink.after(btn);
    } else {
      container.style.position = 'relative';
      btn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:100';
      container.appendChild(btn);
    }
  }

  // ==================== 选组弹窗 ====================

  function showGroupPicker(anchorEl, uid) {
    document.querySelectorAll('.biliban-group-picker').forEach(p => p.remove());
    const picker = document.createElement('div');
    picker.className = 'biliban-group-picker';

    BilibanStorage.getGroups().then(groups => {
      let html = '<div class="biliban-picker-title">选择分组屏蔽</div>';
      if (groups.length === 0) {
        html += '<div class="biliban-picker-item disabled">暂无分组，请先在插件面板创建</div>';
      } else {
        groups.forEach(group => {
          const alreadyIn = group.uids.includes(uid);
          html += '<div class="biliban-picker-item ' + (alreadyIn ? 'disabled' : '') +
            '" data-group-id="' + group.id + '" data-uid="' + uid + '">' +
            (alreadyIn ? '✓ ' : '') + group.name + '</div>';
        });
      }
      html += '<div class="biliban-picker-item biliban-picker-new">+ 新建分组并添加</div>';
      picker.innerHTML = html;

      const rect = anchorEl.getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
      picker.style.top = (rect.bottom + 4) + 'px';
      picker.style.zIndex = '999999';
      document.body.appendChild(picker);

      picker.querySelectorAll('.biliban-picker-item:not(.disabled):not(.biliban-picker-new)').forEach(item => {
        item.addEventListener('click', async () => {
          await BilibanStorage.addUidToGroup(item.dataset.groupId, Number(item.dataset.uid));
          picker.remove();
          blockedUids = await BilibanStorage.getBlockedUids();
          syncUidsToInterceptor();
          removeCardById(uid);
          removeCommentById(uid);
          scanAll();
        });
      });

      picker.querySelector('.biliban-picker-new')?.addEventListener('click', async () => {
        const name = prompt('输入新分组名称：');
        if (name && name.trim()) {
          const group = await BilibanStorage.addGroup(name.trim());
          await BilibanStorage.addUidToGroup(group.id, uid);
          picker.remove();
          blockedUids = await BilibanStorage.getBlockedUids();
          syncUidsToInterceptor();
          removeCardById(uid);
          removeCommentById(uid);
          scanAll();
        }
      });

      setTimeout(() => {
        const close = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
        document.addEventListener('click', close);
      }, 0);
    });
  }


  // ==================== BewlyBewly 卡片处理 ====================

  function injectBewlyStyles(sr) {
    if (!sr || sr.querySelector('#biliban-bewly-style')) return;
    const style = document.createElement('style');
    style.id = 'biliban-bewly-style';
    style.textContent = BLOCK_BTN_CSS;
    sr.appendChild(style);
  }

  function processBewlyCards() {
    const sr = getBewlyShadowRoot();
    if (!sr) return;
    injectBewlyStyles(sr);
    let removed = false;
    const cards = sr.querySelectorAll('.video-card');
    if (cards.length === 0) return;
    cards.forEach(card => {
      if (card[DONE]) return;
      const uid = extractBewlyCardUid(card);
      if (!uid) return;
      card[DONE] = true;
      if (blockedUids.has(uid)) { card.remove(); removed = true; return; }
      injectBewlyBlockBtn(card, uid);
    });
    if (removed) forceReflow();
  }

  function extractBewlyCardUid(el) {
    const spaceLink = el.querySelector('a[href*="space.bilibili.com"]');
    if (spaceLink) {
      const m = spaceLink.href.match(/space\.bilibili\.com\/(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function injectBewlyBlockBtn(card, uid) {
    if (card.querySelector('.biliban-block-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'biliban-block-btn';
    btn.textContent = '屏蔽';
    btn.title = '屏蔽用户 ' + uid;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showBewlyGroupPicker(btn, uid); });
    const channelName = card.querySelector('.channel-name');
    if (channelName) {
      const nameWrap = channelName.parentElement;
      if (nameWrap) nameWrap.classList.add('biliban-no-wrap');
      channelName.after(btn);
      return;
    }
    const spaceLink = card.querySelector('a[href*="space.bilibili.com"]');
    if (spaceLink) {
      const nameArea = spaceLink.parentElement;
      if (nameArea) nameArea.classList.add('biliban-no-wrap');
      spaceLink.after(btn);
      return;
    }
    card.style.position = 'relative';
    btn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:100';
    card.appendChild(btn);
  }

  function showBewlyGroupPicker(anchorEl, uid) {
    document.querySelectorAll('.biliban-group-picker').forEach(p => p.remove());
    const picker = document.createElement('div');
    picker.className = 'biliban-group-picker';
    BilibanStorage.getGroups().then(groups => {
      let html = '<div class="biliban-picker-title">选择分组屏蔽</div>';
      if (groups.length === 0) {
        html += '<div class="biliban-picker-item disabled">暂无分组，请先在插件面板创建</div>';
      } else {
        groups.forEach(group => {
          const alreadyIn = group.uids.includes(uid);
          html += '<div class="biliban-picker-item ' + (alreadyIn ? 'disabled' : '') + '" data-group-id="' + group.id + '" data-uid="' + uid + '">' + (alreadyIn ? '\u2713 ' : '') + group.name + '</div>';
        });
      }
      html += '<div class="biliban-picker-item biliban-picker-new">+ 新建分组并添加</div>';
      picker.innerHTML = html;
      const rect = anchorEl.getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
      picker.style.top = (rect.bottom + 4) + 'px';
      picker.style.zIndex = '999999';
      document.body.appendChild(picker);
      picker.querySelectorAll('.biliban-picker-item:not(.disabled):not(.biliban-picker-new)').forEach(item => {
        item.addEventListener('click', async () => {
          await BilibanStorage.addUidToGroup(item.dataset.groupId, Number(item.dataset.uid));
          picker.remove();
          blockedUids = await BilibanStorage.getBlockedUids();
          syncUidsToInterceptor();
          processBewlyCards();
          scanAll();
        });
      });
      picker.querySelector('.biliban-picker-new')?.addEventListener('click', async () => {
        const name = prompt('输入新分组名称：');
        if (name && name.trim()) {
          const group = await BilibanStorage.addGroup(name.trim());
          await BilibanStorage.addUidToGroup(group.id, uid);
          picker.remove();
          blockedUids = await BilibanStorage.getBlockedUids();
          syncUidsToInterceptor();
          processBewlyCards();
          scanAll();
        }
      });
      setTimeout(() => {
        const close = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
        document.addEventListener('click', close);
      }, 0);
    });
  }

  // ==================== 刷新 ====================

  async function refreshAll() {
    blockedUids = await BilibanStorage.getBlockedUids();
    console.log('[BILIBAN] 刷新完成，当前 ' + blockedUids.size + ' 个 UID');
    syncUidsToInterceptor();

    document.querySelectorAll('[data-' + DONE + ']').forEach(el => delete el.dataset[DONE]);

    const bc = document.querySelector('bili-comments');
    if (bc && bc.shadowRoot) {
      bc.shadowRoot.querySelectorAll('bili-comment-thread-renderer').forEach(thread => {
        if (!thread.shadowRoot) return;
        thread.shadowRoot.querySelectorAll('bili-comment-renderer').forEach(r => delete r[DONE]);
        const replies = thread.shadowRoot.querySelector('bili-comment-replies-renderer');
        if (replies && replies.shadowRoot) {
          replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer').forEach(r => delete r[DONE]);
        }
      });
    }

    scanAll();
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'refresh') refreshAll(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
