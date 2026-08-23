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

  // 分组选择器样式
  const PICKER_CSS = `.biliban-group-picker{background:#2b2b2b;border:1px solid #4a4a4a;border-radius:8px;padding:4px;min-width:180px;max-width:280px;max-height:400px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.biliban-picker-title{padding:8px 12px;font-size:12px;color:#888;font-weight:600;border-bottom:1px solid #404040;margin-bottom:4px}
.biliban-picker-chunk{margin-bottom:2px}
.biliban-picker-chunk-header{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;border-radius:4px;transition:background 0.15s}
.biliban-picker-chunk-header:hover{background:#3a3a3a}
.biliban-picker-chunk-arrow{font-size:8px;color:#888;transition:transform 0.2s;width:12px;text-align:center}
.biliban-picker-chunk-header.expanded .biliban-picker-chunk-arrow{transform:rotate(90deg)}
.biliban-picker-chunk-name{font-size:11px;color:#fb7299;font-weight:600}
.biliban-picker-chunk-count{font-size:10px;color:#666;margin-left:auto}
.biliban-picker-chunk-body{padding-left:8px}
.biliban-picker-item{padding:6px 12px;font-size:13px;color:#e0e0e0;cursor:pointer;border-radius:4px;transition:background 0.15s}
.biliban-picker-item:hover{background:#404040}
.biliban-picker-item.disabled{color:#666;cursor:default}
.biliban-picker-item.disabled:hover{background:transparent}
.biliban-picker-new{color:#fb7299;border-top:1px solid #404040;margin-top:4px;padding-top:8px}
.biliban-picker-new:hover{background:#3a2028}
.biliban-picker-input{width:100%;height:30px;padding:0 8px;margin-bottom:6px;border:1.5px solid #555;border-radius:4px;font-size:12px;outline:none;background:#404040;color:#e0e0e0;box-sizing:border-box}
.biliban-picker-input:focus{border-color:#fb7299}
.biliban-picker-select{width:100%;height:30px;padding:0 8px;margin-bottom:8px;border:1.5px solid #555;border-radius:4px;font-size:12px;outline:none;background:#404040;color:#e0e0e0;box-sizing:border-box}
.biliban-picker-select:focus{border-color:#fb7299}
.biliban-picker-new-actions{display:flex;gap:6px;justify-content:flex-end}
.biliban-picker-btn{height:28px;padding:0 12px;border:1px solid #555;border-radius:4px;background:#3a3a3a;color:#ccc;font-size:12px;cursor:pointer;transition:all 0.15s}
.biliban-picker-btn:hover{border-color:#fb7299;color:#fb7299}
.biliban-picker-btn.primary{background:#fb7299;border-color:#fb7299;color:white;font-weight:600}
.biliban-picker-btn.primary:hover{background:#e6608a;color:white}`;

  // 注入选择器样式
  function injectPickerStyles(doc) {
    if (!doc || doc.querySelector('#biliban-picker-style')) return;
    const style = doc.createElement('style');
    style.id = 'biliban-picker-style';
    style.textContent = PICKER_CSS;
    doc.head ? doc.head.appendChild(style) : doc.appendChild(style);
  }

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
    
    // 注入选择器样式
    injectPickerStyles(document);

    new MutationObserver(() => { scanAll(); checkSpaceBlacklist(); }).observe(document.body, {
      childList: true, subtree: true
    });

    watchGateGrid();

    // Initial scan for elements already in DOM
    scanAll();
    setTimeout(scanAll, 500);
    setTimeout(scanAll, 1500);

    // 空间主页黑名单检测：立即检测 + 延迟检测（等待 SPA 渲染）
    checkSpaceBlacklist();
    setTimeout(checkSpaceBlacklist, 1000);
    setTimeout(checkSpaceBlacklist, 3000);
    setInterval(checkSpaceBlacklist, 2000);

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
      processSpacePage();
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

  async function renderPickerContent(picker, uid) {
    const groups = await BilibanStorage.getGroups();
    const chunks = await BilibanStorage.getChunks();
    const expandState = await BilibanStorage.getChunkExpandState();

    let html = '<div class="biliban-picker-title">选择分组屏蔽</div>';
    
    if (groups.length === 0) {
      html += '<div class="biliban-picker-item disabled">暂无分组，请先在插件面板创建</div>';
    } else {
      // 按块分组
      const groupsByChunk = new Map();
      groupsByChunk.set(null, []);
      
      for (const group of groups) {
        const chunkId = group.chunkId || null;
        if (!groupsByChunk.has(chunkId)) {
          groupsByChunk.set(chunkId, []);
        }
        groupsByChunk.get(chunkId).push(group);
      }

      for (const [chunkId, chunkGroups] of groupsByChunk) {
        if (chunkGroups.length === 0) continue;

        const chunk = chunkId ? chunks.find(c => c.id === chunkId) : null;
        const chunkName = chunk ? chunk.name : '未分组';
        const stateKey = chunkId || '_ungrouped';
        const isExpanded = expandState[stateKey] !== false;

        html += '<div class="biliban-picker-chunk" data-chunk-id="' + stateKey + '">';
        html += '<div class="biliban-picker-chunk-header' + (isExpanded ? ' expanded' : '') + '" data-state-key="' + stateKey + '">';
        html += '<span class="biliban-picker-chunk-arrow">▶</span>';
        html += '<span class="biliban-picker-chunk-name">' + escapeHtml(chunkName) + '</span>';
        html += '<span class="biliban-picker-chunk-count">' + chunkGroups.length + '</span>';
        html += '</div>';
        html += '<div class="biliban-picker-chunk-body"' + (isExpanded ? '' : ' style="display:none"') + '>';

        chunkGroups.forEach(group => {
          const alreadyIn = group.uids.includes(Number(uid));
          html += '<div class="biliban-picker-item ' + (alreadyIn ? 'disabled' : '') +
            '" data-group-id="' + group.id + '" data-uid="' + uid + '">' +
            (alreadyIn ? '✓ ' : '') + escapeHtml(group.name) + '</div>';
        });

        html += '</div></div>';
      }
    }
    html += '<div class="biliban-picker-item biliban-picker-new">+ 新建分组并添加</div>';
    picker.innerHTML = html;

    // 绑定块展开收起事件
    picker.querySelectorAll('.biliban-picker-chunk-header').forEach(header => {
      header.addEventListener('click', async () => {
        const isExpanded = header.classList.contains('expanded');
        header.classList.toggle('expanded', !isExpanded);
        const body = header.nextElementSibling;
        if (body) body.style.display = isExpanded ? 'none' : 'block';
        // 保存展开状态
        await BilibanStorage.setChunkExpandState(header.dataset.stateKey, !isExpanded);
      });
    });

    // 绑定分组点击事件
    picker.querySelectorAll('.biliban-picker-item:not(.disabled):not(.biliban-picker-new)').forEach(item => {
      item.addEventListener('click', async () => {
        const result = await BilibanStorage.addUidToGroup(item.dataset.groupId, Number(item.dataset.uid));
        if (!result.ok) {
          if (result.reason === 'duplicate') {
            showContentToast('该用户已在「' + (result.groupName || '该分组') + '」中', 'warn');
          }
          return;
        }
        picker.remove();
        blockedUids = await BilibanStorage.getBlockedUids();
        syncUidsToInterceptor();
        removeCardById(uid);
        removeCommentById(uid);
        scanAll();
      });
    });

    // 新建分组
    picker.querySelector('.biliban-picker-new')?.addEventListener('click', async () => {
      renderNewGroupForm(picker, uid);
    });
  }

  // 渲染"新建分组"表单（支持选择所属块）
  async function renderNewGroupForm(picker, uid) {
    const chunks = await BilibanStorage.getChunks();
    let html = '<div class="biliban-picker-title">新建分组并添加</div>';
    html += '<input type="text" class="biliban-picker-input" id="biliban-new-group-name" placeholder="输入分组名称">';
    if (chunks.length > 0) {
      html += '<select class="biliban-picker-select" id="biliban-new-group-chunk">';
      html += '<option value="">不分配块</option>';
      chunks.forEach(c => {
        html += '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>';
      });
      html += '</select>';
    }
    html += '<div class="biliban-picker-new-actions">';
    html += '<button class="biliban-picker-btn" id="biliban-new-group-cancel">取消</button>';
    html += '<button class="biliban-picker-btn primary" id="biliban-new-group-ok">创建</button>';
    html += '</div>';
    picker.innerHTML = html;

    const nameInput = picker.querySelector('#biliban-new-group-name');
    const chunkSelect = picker.querySelector('#biliban-new-group-chunk');
    nameInput.focus();

    const doCreate = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const chunkId = chunkSelect ? chunkSelect.value || null : null;
      const group = await BilibanStorage.addGroup(name, chunkId);
      const result = await BilibanStorage.addUidToGroup(group.id, uid);
      if (!result.ok) {
        if (result.reason === 'duplicate') {
          showContentToast('该用户已在「' + (result.groupName || '该分组') + '」中', 'warn');
        }
        return;
      }
      picker.remove();
      blockedUids = await BilibanStorage.getBlockedUids();
      syncUidsToInterceptor();
      removeCardById(uid);
      removeCommentById(uid);
      scanAll();
    };

    picker.querySelector('#biliban-new-group-ok').addEventListener('click', doCreate);
    picker.querySelector('#biliban-new-group-cancel').addEventListener('click', () => picker.remove());
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
  }

  function showGroupPicker(anchorEl, uid) {
    document.querySelectorAll('.biliban-group-picker').forEach(p => p.remove());
    const picker = document.createElement('div');
    picker.className = 'biliban-group-picker';

    const rect = anchorEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.zIndex = '999999';
    document.body.appendChild(picker);

    renderPickerContent(picker, uid);

    setTimeout(() => {
      const close = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
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

    const rect = anchorEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.zIndex = '999999';
    document.body.appendChild(picker);

    renderPickerContent(picker, uid);

    setTimeout(() => {
      const close = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
  }

  // ==================== 空间主页黑名单检测 ====================

  let _lastCheckedSpaceUid = null;

  /**
   * 从 URL 提取空间页 UID
   * 支持 /521281162、/521281162/video、/521281162/dynamic 等格式
   */
  function getSpaceUidFromUrl() {
    // pathname 形如 /521281162 或 /521281162/dynamic
    const m = window.location.pathname.match(/^\/(\d+)/);
    if (m) return Number(m[1]);
    // 兜底：完整 URL 匹配
    const fullMatch = window.location.href.match(/space\.bilibili\.com\/(\d+)/);
    if (fullMatch) return Number(fullMatch[1]);
    return null;
  }

  /**
   * 从 DOM 提取空间页 UID（作为 URL 的验证/兜底）
   * 目标元素结构：
   * <div class="info-section__content">
   *   <div class="info-item">
   *     <i class="vui_icon sic-fsp-uid_line icon"></i>
   *     <div class="vui_ellipsis multi-mode">521281162</div>
   *   </div>
   * </div>
   */
  function getSpaceUidFromDom() {
    // 策略1：通过 UID 图标定位
    const uidIcon = document.querySelector('.sic-fsp-uid_line');
    if (uidIcon) {
      const infoItem = uidIcon.closest('.info-item');
      if (infoItem) {
        const uidEl = infoItem.querySelector('.vui_ellipsis') || infoItem.querySelector('[class*="vui_ellipsis"]');
        if (uidEl) {
          const text = uidEl.textContent.trim();
          if (/^\d+$/.test(text)) return Number(text);
        }
      }
    }

    // 策略2：遍历 info-section__content 下的 info-item，找纯数字内容
    const infoItems = document.querySelectorAll('.info-section__content .info-item');
    for (const item of infoItems) {
      const uidEl = item.querySelector('.vui_ellipsis') || item.querySelector('[class*="vui_ellipsis"]');
      if (uidEl) {
        const text = uidEl.textContent.trim();
        if (/^\d+$/.test(text)) return Number(text);
      }
    }

    // 策略3：暴力搜索所有 .info-item
    const allInfoItems = document.querySelectorAll('.info-item');
    for (const item of allInfoItems) {
      const text = item.textContent.trim();
      if (/^\d{5,12}$/.test(text)) return Number(text);
    }

    return null;
  }

  /**
   * 检测当前是否在用户空间主页，若是则检查黑名单
   */
  function checkSpaceBlacklist() {
    // 仅在 space.bilibili.com 上运行
    if (!window.location.hostname.includes('space.bilibili.com')) return;

    // 从 URL 提取 UID（主要方式）
    let uid = getSpaceUidFromUrl();

    // URL 提取失败时，从 DOM 提取（兜底）
    if (!uid) {
      uid = getSpaceUidFromDom();
    }

    if (!uid) return;

    // 已检测过此 UID，不重复弹窗
    if (_lastCheckedSpaceUid === uid) return;
    _lastCheckedSpaceUid = uid;

    // 移除旧提醒
    document.querySelectorAll('.biliban-space-alert').forEach(el => el.remove());

    // 异步查询黑名单分组
    BilibanStorage.findGroupsByUid(uid).then(matchedGroups => {
      // 查询期间 UID 可能已变化
      if (_lastCheckedSpaceUid !== uid) return;
      if (matchedGroups.length === 0) return;
      showSpaceBlacklistAlert(uid, matchedGroups);
    });
  }

  /**
   * 显示黑名单提醒弹窗
   */
  function showSpaceBlacklistAlert(uid, groups) {
    const groupTexts = groups.map(g =>
      g.name + (g.enabled ? '' : '（已禁用）')
    );

    const alert = document.createElement('div');
    alert.className = 'biliban-space-alert';

    const groupList = groupTexts.map(name =>
      '<span class="biliban-space-alert-tag">' + escapeHtml(name) + '</span>'
    ).join('');

    alert.innerHTML =
      '<div class="biliban-space-alert-icon">🚫</div>' +
      '<div class="biliban-space-alert-content">' +
        '<div class="biliban-space-alert-title">该用户已在黑名单中</div>' +
        '<div class="biliban-space-alert-detail">UID: ' + uid + '</div>' +
        '<div class="biliban-space-alert-groups">' + groupList + '</div>' +
      '</div>' +
      '<button class="biliban-space-alert-close" title="关闭">×</button>';

    document.body.appendChild(alert);

    // 关闭按钮
    alert.querySelector('.biliban-space-alert-close').addEventListener('click', function() {
      removeAlert(alert);
    });

    // 10 秒后自动消失
    setTimeout(function() {
      removeAlert(alert);
    }, 10000);
  }

  function removeAlert(alert) {
    if (!alert || !alert.parentNode) return;
    alert.style.opacity = '0';
    alert.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(function() { if (alert.parentNode) alert.remove(); }, 300);
  }

  /**
   * 页面内浮动提示（轻量 toast）
   * @param {string} msg - 提示文本
   * @param {string} type - 'info' | 'warn' | 'error'
   */
  function showContentToast(msg, type) {
    document.querySelectorAll('.biliban-content-toast').forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = 'biliban-content-toast';
    const bg = type === 'error' ? '#ff4d4f' : type === 'warn' ? '#faad14' : '#00a1d6';
    toast.style.cssText =
      'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
      'background:' + bg + ';color:#fff;padding:10px 20px;border-radius:8px;' +
      'font-size:14px;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);' +
      'opacity:0;transition:opacity 0.3s,transform 0.3s;pointer-events:none;max-width:90vw;';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(function() {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-10px)';
      setTimeout(function() { if (toast.parentNode) toast.remove(); }, 300);
    }, 2500);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * 空间主页：在用户名旁注入屏蔽按钮
   * 目标结构：
   * <div class="upinfo-detail__top">
   *   <div class="nickname">于凉</div>
   *   <a class="level">...</a>
   * </div>
   */
  function processSpacePage() {
    // 仅在 space.bilibili.com 上运行
    if (!window.location.hostname.includes('space.bilibili.com')) return;

    const nicknameEl = document.querySelector('.upinfo-detail__top .nickname');
    if (!nicknameEl) return;

    const topContainer = nicknameEl.closest('.upinfo-detail__top');
    if (!topContainer) return;

    // 获取 UID（URL 优先，DOM 兜底）
    const uid = getSpaceUidFromUrl() || getSpaceUidFromDom();
    if (!uid) return;

    const isBlocked = blockedUids.has(uid);
    const expectedText = isBlocked ? '已拉黑' : '屏蔽';

    // 已有按钮：检查 UID 是否一致，不一致则重建
    const existingBtn = topContainer.querySelector('.biliban-block-btn');
    if (existingBtn) {
      if (existingBtn._bibanUid === uid) {
        // 同一 UID，仅同步屏蔽状态
        if (existingBtn.textContent !== expectedText) {
          existingBtn.textContent = expectedText;
          existingBtn.classList.toggle('biliban-blocked', isBlocked);
        }
        return;
      }
      // UID 变了（SPA 导航到另一个用户），移除旧按钮
      existingBtn.remove();
    }

    // 创建按钮
    const btn = document.createElement('button');
    btn.className = 'biliban-block-btn biliban-space-block-btn' + (isBlocked ? ' biliban-blocked' : '');
    btn.textContent = expectedText;
    btn.title = '屏蔽用户 ' + uid;
    btn._bibanUid = uid;
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      showGroupPicker(btn, uid);
    });

    // 插入到昵称后面
    nicknameEl.after(btn);
  }


  // ==================== 刷新 ====================

  async function refreshAll() {
    blockedUids = await BilibanStorage.getBlockedUids();
    console.log('[BILIBAN] 刷新完成，当前 ' + blockedUids.size + ' 个 UID');
    syncUidsToInterceptor();

    // 重置空间检测状态，让黑名单变更后重新检查
    _lastCheckedSpaceUid = null;
    checkSpaceBlacklist();

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
