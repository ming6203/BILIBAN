/**
 * BILIBAN 完整管理面板 (options page)
 *
 * 两个功能区：
 *  1. 黑名单管理 —— 分组/分块的完整增删改查（原弹窗重逻辑迁移至此）
 *  2. 评论扫描 —— 爬取当前视频评论区 → 批量匹配黑名单 → 筛选/标记命中用户，
 *     替代逐条点击「屏蔽」按钮；爬取由 background service worker 执行，
 *     本页仅做指令下发与结果展示/批量操作。
 */

// ==================== DOM ====================
const tabs = document.querySelectorAll('.tab');
const tabBlacklist = document.getElementById('tab-blacklist');
const tabScan = document.getElementById('tab-scan');

const btnAddGroup = document.getElementById('btn-add-group');
const btnAddChunk = document.getElementById('btn-add-chunk');
const groupsContainer = document.getElementById('groups-container');
const statsEl = document.getElementById('stats');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const fileImport = document.getElementById('file-import');

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

// 扫描
const scanVideoInput = document.getElementById('scan-video-input');
const scanUseTab = document.getElementById('scan-use-tab');
const scanMode = document.getElementById('scan-mode');
const scanTimeRangeItem = document.getElementById('scan-time-range-item');
const scanTimeValue = document.getElementById('scan-time-value');
const scanTimeUnit = document.getElementById('scan-time-unit');
const scanMaxPages = document.getElementById('scan-max-pages');
const scanSubReplies = document.getElementById('scan-sub-replies');
const scanRowClick = document.getElementById('scan-row-click');
const scanStart = document.getElementById('scan-start');
const scanStop = document.getElementById('scan-stop');
const scanVideoInfo = document.getElementById('scan-video-info');
const scanProgress = document.getElementById('scan-progress');
const scanProgressBar = document.getElementById('scan-progress-bar');
const scanProgressText = document.getElementById('scan-progress-text');
const scanNote = document.getElementById('scan-note');
const scanResults = document.getElementById('scan-results');
const scanResultSummary = document.getElementById('scan-result-summary');
const scanSelectAll = document.getElementById('scan-select-all');
const scanBatchGroup = document.getElementById('scan-batch-group');
const scanBatchAdd = document.getElementById('scan-batch-add');
const scanBatchIgnore = document.getElementById('scan-batch-ignore');
const scanBatchHint = document.getElementById('scan-batch-hint');
const scanResultList = document.getElementById('scan-result-list');
const scanSearchInput = document.getElementById('scan-search-input');
const scanSearchCount = document.getElementById('scan-search-count');

// ==================== 状态 ====================
let draggedCard = null;
let draggedGroupId = null;

const scanViewState = {
  search: '',              // 评论搜索关键词
  selected: new Set(),     // 选中 uid
  ignored: new Set(),      // 本次扫描中被忽略的 uid（内存态）
  added: new Set(),        // 已加入黑名单的 uid（内存态，用于徽标）
  results: [],             // 最新一份结果
  status: 'idle'           // idle | running | done | stopped | error
};

// ==================== 工具函数 ====================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showModal(title, bodyHTML, onConfirm, confirmText = '确认') {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHTML;
  modalConfirm.textContent = confirmText;
  modalOverlay.style.display = 'flex';
  return new Promise((resolve) => {
    modalConfirm.onclick = () => { modalOverlay.style.display = 'none'; resolve(onConfirm()); };
    modalCancel.onclick = () => { modalOverlay.style.display = 'none'; resolve(null); };
  });
}

function showToast(msg) {
  let t = document.getElementById('biliban-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'biliban-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(function() { t.style.opacity = '0'; }, 2000);
}

// ==================== Tab 切换 ====================

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    tabBlacklist.classList.toggle('active', tab.dataset.tab === 'blacklist');
    tabScan.classList.toggle('active', tab.dataset.tab === 'scan');
  });
});

// ==================== 黑名单管理：渲染 ====================

async function render() {
  const groups = await BilibanStorage.getGroups();
  const chunks = await BilibanStorage.getChunks();
  const expandState = await BilibanStorage.getChunkExpandState();

  // 记录当前已展开的分组（group-card 的展开态未持久化，重渲染后会丢失，
  // 若在此记录、渲染完成后恢复，可避免删除 uid 等操作导致分组自动收起）
  const expandedGroups = new Set(
    Array.from(document.querySelectorAll('.group-card.expanded')).map(c => c.dataset.groupId)
  );

  groupsContainer.innerHTML = '';

  if (groups.length === 0) {
    groupsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">还没有屏蔽分组<br>点击上方按钮创建第一个分组</div>
      </div>`;
  } else {
    const groupsByChunk = new Map();
    groupsByChunk.set(null, []);

    for (const group of groups) {
      const chunkId = group.chunkId || null;
      if (!groupsByChunk.has(chunkId)) groupsByChunk.set(chunkId, []);
      groupsByChunk.get(chunkId).push(group);
    }

    for (const [chunkId, chunkGroups] of groupsByChunk) {
      if (chunkGroups.length === 0) continue;

      const chunk = chunkId ? chunks.find(c => c.id === chunkId) : null;
      const chunkName = chunk ? chunk.name : '未分组';
      const stateKey = chunkId || '_ungrouped';
      const isExpanded = expandState[stateKey] !== false;

      const chunkContainer = document.createElement('div');
      chunkContainer.className = 'chunk-group-container';
      chunkContainer.dataset.chunkId = stateKey;

      const chunkHeader = document.createElement('div');
      chunkHeader.className = 'chunk-group-header' + (isExpanded ? ' expanded' : '');
      chunkHeader.innerHTML = `
        <div class="chunk-group-left">
          <span class="chunk-group-expand">▶</span>
          <span class="chunk-group-name">${escapeHtml(chunkName)}</span>
          <span class="chunk-group-count">${chunkGroups.length} 个分组</span>
        </div>`;

      chunkHeader.addEventListener('click', async () => {
        const nowExpanded = !chunkHeader.classList.contains('expanded');
        chunkHeader.classList.toggle('expanded', nowExpanded);
        await BilibanStorage.setChunkExpandState(stateKey, nowExpanded);
      });

      chunkContainer.appendChild(chunkHeader);

      const chunkBody = document.createElement('div');
      chunkBody.className = 'chunk-group-body';

      for (const group of chunkGroups) {
        const card = document.createElement('div');
        card.className = 'group-card';
        card.dataset.groupId = group.id;

        const uidTags = group.uids.length > 0
          ? group.uids.map(uid => `
            <div class="uid-tag">
              <span>${uid}</span>
              <button class="uid-remove" data-uid="${uid}" data-group-id="${group.id}" title="移除">×</button>
            </div>`).join('')
          : '<div class="empty-group">该分组暂无用户</div>';

        const chunkBadge = chunk ? `<span class="group-chunk-badge">${escapeHtml(chunk.name)}</span>` : '';

        card.innerHTML = `
          <div class="group-header">
            <div class="drag-handle" data-group-id="${group.id}" title="拖拽排序">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
              </svg>
            </div>
            <div class="group-toggle ${group.enabled ? 'active' : ''}" data-group-id="${group.id}"></div>
            <div class="group-name">${escapeHtml(group.name)}</div>
            ${chunkBadge}
            <div class="group-count">${group.uids.length} 人</div>
            <div class="group-expand">▼</div>
            <div class="group-actions">
              <button class="group-action-btn" data-action="rename" data-group-id="${group.id}" title="重命名">✏️</button>
              <button class="group-action-btn" data-action="move" data-group-id="${group.id}" title="移动到块">📦</button>
              <button class="group-action-btn" data-action="delete" data-group-id="${group.id}" title="删除分组">🗑️</button>
            </div>
          </div>
          <div class="group-body">
            <div class="uid-list">${uidTags}</div>
            <div class="uid-add-row">
              <input type="text" class="uid-add-input" placeholder="输入 UID 添加到此分组" inputmode="numeric">
              <button class="secondary-btn-sm uid-add-btn" data-group-id="${group.id}">添加</button>
            </div>
          </div>`;

        chunkBody.appendChild(card);
      }

      chunkContainer.appendChild(chunkBody);
      groupsContainer.appendChild(chunkContainer);
    }
  }

  let totalUids = new Set();
  for (const g of groups) g.uids.forEach(uid => totalUids.add(uid));
  statsEl.textContent = `${groups.length} 个分组 · ${totalUids.size} 个用户 · ${chunks.length} 个分块`;

  // 恢复渲染前已展开的分组，避免删除 uid 等操作导致分组自动收起
  if (expandedGroups.size > 0) {
    document.querySelectorAll('.group-card').forEach(c => {
      if (expandedGroups.has(c.dataset.groupId)) c.classList.add('expanded');
    });
  }

  bindEvents();
  renderChunkManageButtons();
  renderScanBatchGroupOptions();
}

// ==================== 黑名单管理：事件 ====================

function bindEvents() {
  document.querySelectorAll('.group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.group-toggle') || e.target.closest('.group-action-btn') || e.target.closest('.drag-handle') ||
          e.target.closest('.uid-add-btn') || e.target.closest('.uid-remove') || e.target.closest('.uid-add-input')) return;
      header.parentElement.classList.toggle('expanded');
    });
  });

  document.querySelectorAll('.group-toggle').forEach(toggle => {
    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      await BilibanStorage.toggleGroup(toggle.dataset.groupId);
      render();
    });
  });

  document.querySelectorAll('.uid-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await BilibanStorage.removeUidFromGroup(btn.dataset.groupId, Number(btn.dataset.uid));
      render();
    });
  });

  // 组内快速添加 UID
  document.querySelectorAll('.uid-add-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = btn.parentElement.querySelector('.uid-add-input');
      const uid = parseInt(input.value.trim(), 10);
      if (!uid || isNaN(uid) || uid <= 0) { showToast('请输入有效的 UID'); return; }
      const result = await BilibanStorage.addUidToGroup(btn.dataset.groupId, uid);
      if (result.ok) { input.value = ''; render(); showToast('✅ 已添加'); }
      else if (result.reason === 'duplicate') showToast('该用户已在「' + (result.groupName || '该分组') + '」中');
      else showToast('添加失败');
    });
  });
  document.querySelectorAll('.uid-add-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const btn = input.parentElement.querySelector('.uid-add-btn');
        if (btn) btn.click();
      }
    });
  });

  document.querySelectorAll('.group-action-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const groupId = btn.dataset.groupId;

      if (action === 'delete') {
        const result = await showModal('删除分组', '<p>确定要删除这个分组吗？组内用户将被一并移除。</p>',
          async () => { await BilibanStorage.removeGroup(groupId); });
        if (result !== null) { render(); showToast('🗑️ 分组已删除'); }
      }

      if (action === 'rename') {
        const groups = await BilibanStorage.getGroups();
        const group = groups.find(g => g.id === groupId);
        const result = await showModal('重命名分组',
          `<p>输入新的分组名称：</p><input type="text" id="rename-input" value="${escapeHtml(group.name)}">`,
          async () => {
            const input = document.getElementById('rename-input');
            if (input.value.trim()) await BilibanStorage.renameGroup(groupId, input.value.trim());
          });
        if (result !== null) render();
      }

      if (action === 'move') {
        await showMoveGroupDialog(groupId);
      }
    });
  });

  bindDragEvents();
}

// ==================== 拖拽排序 ====================

function bindDragEvents() {
  document.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const card = handle.closest('.group-card');
      draggedCard = card;
      draggedGroupId = handle.dataset.groupId;

      card.classList.add('dragging');

      const onMouseMove = (moveEvent) => {
        const targetCard = findTargetCard(moveEvent.clientX, moveEvent.clientY);
        document.querySelectorAll('.group-card.drag-over').forEach(c => c.classList.remove('drag-over'));
        if (targetCard && targetCard !== draggedCard) targetCard.classList.add('drag-over');
      };

      const onMouseUp = async (upEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        const targetCard = findTargetCard(upEvent.clientX, upEvent.clientY);

        if (targetCard && targetCard !== draggedCard) {
          const targetGroupId = targetCard.dataset.groupId;
          const groups = await BilibanStorage.getGroups();
          const groupIds = groups.map(g => g.id);
          const fromIndex = groupIds.indexOf(draggedGroupId);
          const toIndex = groupIds.indexOf(targetGroupId);

          if (fromIndex !== -1 && toIndex !== -1) {
            const [movedGroup] = groupIds.splice(fromIndex, 1);
            groupIds.splice(toIndex, 0, movedGroup);
            await BilibanStorage.reorderGroups(groupIds);
            render();
            showToast('✅ 分组顺序已更新');
          }
        }

        document.querySelectorAll('.group-card').forEach(c => c.classList.remove('dragging', 'drag-over'));
        draggedCard = null;
        draggedGroupId = null;
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

function findTargetCard(x, y) {
  const cards = document.querySelectorAll('.group-card');
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return card;
    }
  }
  return null;
}

// ==================== 分块管理 ====================

btnAddChunk.addEventListener('click', async () => {
  const groups = await BilibanStorage.getGroups();
  const result = await showModal('创建新块', `
    <label style="font-size:12px;color:#aaa">块名称</label>
    <input type="text" id="chunk-name-input" placeholder="如：广告号、杠精...">
    <label style="display:block;font-size:12px;color:#aaa;margin-top:12px">选择分组（可选）</label>
    <div class="group-assign-list">
      ${groups.map(g => `
        <div class="group-assign-item">
          <input type="checkbox" class="group-assign-checkbox" data-group-id="${g.id}">
          <span class="group-assign-name">${escapeHtml(g.name)}</span>
          <span class="group-assign-count">${g.uids.length} 人</span>
        </div>
      `).join('')}
    </div>`, async () => {
    const name = document.getElementById('chunk-name-input')?.value.trim();
    if (!name) return null;
    const chunk = await BilibanStorage.addChunk(name);
    const checkboxes = document.querySelectorAll('.group-assign-checkbox:checked');
    for (const cb of checkboxes) {
      await BilibanStorage.moveGroupToChunk(cb.dataset.groupId, chunk.id);
    }
    return chunk;
  });

  if (result !== null) {
    render();
    showToast('✅ 块「' + result.name + '」已创建');
  }
});

async function showMoveGroupDialog(groupId) {
  const chunks = await BilibanStorage.getChunks();
  const groups = await BilibanStorage.getGroups();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  const result = await showModal('移动到块', `
    <p>将「${escapeHtml(group.name)}」移动到：</p>
    <div style="margin-top:12px">
      <label style="display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;border-radius:6px;background:#404040;margin-bottom:4px">
        <input type="radio" name="move-chunk" value="" ${!group.chunkId ? 'checked' : ''}>
        <span>未分组</span>
      </label>
      ${chunks.map(c => `
        <label style="display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;border-radius:6px;background:#404040;margin-bottom:4px">
          <input type="radio" name="move-chunk" value="${c.id}" ${group.chunkId === c.id ? 'checked' : ''}>
          <span>${escapeHtml(c.name)}</span>
        </label>
      `).join('')}
    </div>`, async () => {
    const selectedChunk = document.querySelector('input[name="move-chunk"]:checked');
    const chunkId = selectedChunk ? selectedChunk.value || null : null;
    await BilibanStorage.moveGroupToChunk(groupId, chunkId);
    return true;
  });

  if (result !== null) { render(); showToast('✅ 分组已移动'); }
}

function renderChunkManageButtons() {
  document.querySelectorAll('.chunk-group-header').forEach(header => {
    const container = header.closest('.chunk-group-container');
    if (!container) return;
    const chunkId = container.dataset.chunkId;
    if (chunkId === '_ungrouped') return;

    const manageBtns = document.createElement('div');
    manageBtns.className = 'chunk-manage-btns';
    manageBtns.style.cssText = 'display:flex;gap:2px;align-items:center';
    manageBtns.innerHTML = `
      <button class="group-action-btn" data-chunk-action="edit" data-chunk-id="${chunkId}" title="编辑分块">✏️</button>
      <button class="group-action-btn" data-chunk-action="delete" data-chunk-id="${chunkId}" title="删除分块">🗑️</button>`;
    // 幂等化：先移除已有的按钮，避免重复调用时叠加出两组
    header.querySelector(".chunk-manage-btns")?.remove();
    header.appendChild(manageBtns);

    manageBtns.querySelector('[data-chunk-action="edit"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await showEditChunkDialog(chunkId);
    });
    manageBtns.querySelector('[data-chunk-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteChunkFlow(chunkId);
    });
  });
}

async function showEditChunkDialog(chunkId) {
  const chunks = await BilibanStorage.getChunks();
  const chunk = chunks.find(c => c.id === chunkId);
  if (!chunk) return;

  const groups = await BilibanStorage.getGroups();

  const result = await showModal('编辑分块', `
    <label style="font-size:12px;color:#aaa">块名称</label>
    <input type="text" id="chunk-name-input" value="${escapeHtml(chunk.name)}">
    <p style="margin-top:4px;font-size:12px;color:#999">重命名仅影响本地；云端文件名将在下次推送时自动跟随更新</p>
    <label style="display:block;font-size:12px;color:#aaa;margin-top:12px">包含的分组</label>
    <div class="group-assign-list">
      ${groups.map(g => `
        <div class="group-assign-item">
          <input type="checkbox" class="group-assign-checkbox" data-group-id="${g.id}" ${g.chunkId === chunkId ? 'checked' : ''}>
          <span class="group-assign-name">${escapeHtml(g.name)}</span>
          <span class="group-assign-count">${g.uids.length} 人</span>
        </div>
      `).join('')}
    </div>`, async () => {
    const newName = document.getElementById('chunk-name-input')?.value.trim();
    if (!newName) return null;

    await BilibanStorage.renameChunk(chunkId, newName);

    const checkboxes = document.querySelectorAll('.group-assign-checkbox');
    for (const cb of checkboxes) {
      const groupId = cb.dataset.groupId;
      if (cb.checked) {
        await BilibanStorage.moveGroupToChunk(groupId, chunkId);
      } else {
        const group = groups.find(g => g.id === groupId);
        if (group && group.chunkId === chunkId) {
          await BilibanStorage.moveGroupToChunk(groupId, null);
        }
      }
    }
    return { name: newName };
  });

  if (result !== null) { render(); showToast('✅ 分块已更新'); }
}

async function deleteChunkFlow(chunkId) {
  const allChunks = await BilibanStorage.getChunks();
  const chunk = allChunks.find(c => c.id === chunkId);
  const result = await showModal('删除分块',
    '<p>确定要删除这个块吗？块内的分组不会被删除，只会取消分组归属。</p>' +
    '<p style="margin-top:8px">☁️ 若已配置 GitHub 同步，云端对应的备份文件也会一并删除。</p>',
    async () => {
      await BilibanStorage.removeChunk(chunkId);
      if (chunk) {
        try {
          const del = await BilibanGithubSync.deleteChunk(chunk);
          if (del.deleted) showToast('☁️ ' + del.message);
        } catch (e) {
          showToast('⚠️ 云端文件删除失败: ' + e.message);
        }
      }
    });
  if (result !== null) render();
}

// ==================== 新建分组 ====================

btnAddGroup.addEventListener('click', async () => {
  const chunks = await BilibanStorage.getChunks();
  const result = await showModal('新建分组',
    `<p>输入分组名称：</p>
     <input type="text" id="new-group-name" placeholder="如：杠精、广告号...">
     <p style="margin-top:12px">选择所属块（可选）：</p>
     <select id="new-group-chunk">
       <option value="">不分配块</option>
       ${chunks.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
     </select>`,
    async () => {
      const input = document.getElementById('new-group-name');
      if (input.value.trim()) {
        const chunkSelect = document.getElementById('new-group-chunk');
        const group = await BilibanStorage.addGroup(input.value.trim(), chunkSelect.value || null);
        return group;
      }
      return null;
    });
  if (result !== null) render();
});

// ==================== 本地导入导出 ====================

btnExport.addEventListener('click', async () => {
  const json = await BilibanStorage.exportData();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `biliban_blacklist_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

btnImport.addEventListener('click', () => { fileImport.click(); });

fileImport.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let importedData;
  try {
    importedData = JSON.parse(text);
    if (!importedData.groups || !Array.isArray(importedData.groups)) throw new Error();
  } catch {
    showToast('文件格式无效');
    fileImport.value = '';
    return;
  }

  const totalImported = importedData.groups.reduce((sum, g) => sum + (g.uids || []).length, 0);
  const result = await showModal('导入黑名单',
    `<p>文件包含 <strong>${importedData.groups.length}</strong> 个分组，共 <strong>${totalImported}</strong> 个用户</p>
     <p style="margin-top:12px">选择导入模式：</p>
     <div style="margin-top:8px">
       <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer">
         <input type="radio" name="import-mode" value="merge" checked> 合并 — 添加到同名分组
       </label>
       <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer">
         <input type="radio" name="import-mode" value="replace"> 覆盖 — 清空并替换
       </label>
     </div>`,
    async () => {
      const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';
      await BilibanStorage.importData(text, mode);
    });
  fileImport.value = '';
  if (result !== null) { render(); showToast('✅ 导入完成'); }
});

// ==================== 评论扫描：指令下发 ====================

// 扫描设置记忆：最大页数与「展开楼中楼」持久化，下次打开管理页自动恢复
const SCAN_SETTINGS_KEY = 'biliban_scan_settings';

function readMaxPages() {
  const pages = scanMaxPages.value.trim();
  return pages === '' ? 10 : parseInt(pages, 10) || 0;
}

// 时间范围转秒（仅最新模式使用）；返回 null 表示未启用
function readTimeRangeSeconds() {
  if (Number(scanMode.value) !== 2) return null;
  const value = parseInt(scanTimeValue.value, 10);
  if (!value || value <= 0) return null;
  const units = { s: 1, h: 3600, d: 86400, m: 2592000, y: 31536000 };
  const unit = units[scanTimeUnit.value];
  if (!unit) return null;
  return value * unit;
}

function readTimeRangeText() {
  const value = parseInt(scanTimeValue.value, 10);
  if (!value || value <= 0) return null;
  const labels = { s: '秒', h: '小时', d: '天', m: '月', y: '年' };
  return `最近 ${value} ${labels[scanTimeUnit.value] || ''}`.trim();
}

// 排序切换：「最新」显示时间范围选项（也在 scanMode 的完整 change 监听中处理）

async function saveScanSettings() {
  try {
    await chrome.storage.local.set({
      [SCAN_SETTINGS_KEY]: {
        maxPages: readMaxPages(),
        includeSub: scanSubReplies.checked,
        rowClick: scanRowClick.checked,
        mode: parseInt(scanMode.value, 10) || 3,
        timeValue: parseInt(scanTimeValue.value, 10) || 1,
        timeUnit: scanTimeUnit.value || 'd'
      }
    });
  } catch (e) { /* 保存失败不影响使用 */ }
}

async function loadScanSettings() {
  try {
    const result = await chrome.storage.local.get(SCAN_SETTINGS_KEY);
    const s = result[SCAN_SETTINGS_KEY];
    if (!s) return;
    if (s.maxPages != null) scanMaxPages.value = s.maxPages;
    if (s.includeSub != null) scanSubReplies.checked = !!s.includeSub;
    if (s.rowClick != null) scanRowClick.checked = !!s.rowClick;
    if (s.mode != null) scanMode.value = s.mode;
    if (s.timeValue != null) scanTimeValue.value = s.timeValue;
    if (s.timeUnit != null) scanTimeUnit.value = s.timeUnit;
    updateTimeRangeVisibility();
  } catch (e) { /* 恢复失败用默认值 */ }
}

function updateTimeRangeVisibility() {
  scanTimeRangeItem.style.display = Number(scanMode.value) === 2 ? '' : 'none';
}

let settingsSaveTimer = null;
scanMaxPages.addEventListener('input', () => {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveScanSettings, 300);
});
scanSubReplies.addEventListener('change', saveScanSettings);
scanRowClick.addEventListener('change', () => { renderScanResults(); saveScanSettings(); });
scanMode.addEventListener('change', () => {
  updateTimeRangeVisibility();
  saveScanSettings();
});
scanTimeValue.addEventListener('input', () => {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveScanSettings, 300);
});
scanTimeUnit.addEventListener('change', saveScanSettings);

async function sendToBackground(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: '无法连接后台：' + (e && e.message || e) };
  }
}

function parseVideoInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // 提取 bvid / av 号 / 纯数字 aid
  const bv = raw.match(/BV[0-9A-Za-z]{8,}/);
  if (bv) return bv[0];
  const av = raw.match(/av(\d+)/i);
  if (av) return av[1];
  const num = raw.match(/^\d{6,}$/);
  if (num) return num[0];
  return null;
}

scanUseTab.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      showToast('无法读取当前标签页，请手动粘贴视频链接');
      return;
    }
    const bv = tab.url.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const av = tab.url.match(/\/video\/av(\d+)/i);
    if (bv) { scanVideoInput.value = bv[1]; }
    else if (av) { scanVideoInput.value = av[1]; }
    else { showToast('当前页面不是 B 站视频页'); }
  } catch (e) {
    showToast('无法读取当前标签页：' + (e.message || e));
  }
});

scanStart.addEventListener('click', async () => {
  const input = scanVideoInput.value.trim();
  if (!input) { showToast('请先输入视频链接 / BV号 / av号'); return; }

  const pages = scanMaxPages.value.trim();
  const options = {
    // 空值回退 10；0 == "不限页数"（全量），不能走 || 默认值
    maxPages: pages === '' ? 10 : parseInt(pages, 10) || 0,
    includeSub: scanSubReplies.checked,
    mode: parseInt(scanMode.value, 10) || 3
  };

  // 最新模式 + 时间范围：把"最近 N 单位"换算为秒级时间窗传给后台
  if (options.mode === 2) {
    const maxAgeSeconds = readTimeRangeSeconds();
    if (maxAgeSeconds) {
      options.maxAgeSeconds = maxAgeSeconds;
      options.timeRangeText = readTimeRangeText();
    }
  }

  // 开始扫描时同步一次设置记忆
  saveScanSettings();

  scanStart.disabled = true;
  scanStop.disabled = false;

  // 重置视图状态
  scanViewState.selected.clear();
  scanViewState.ignored.clear();
  scanViewState.added.clear();

  const resp = await sendToBackground({ type: 'BILIBAN_SCAN_START', videoRef: input, options });

  if (resp && resp.ok === false) {
    showToast('❌ ' + resp.error);
    scanStart.disabled = false;
    scanStop.disabled = true;
  } else if (!resp) {
    // 后台服务可能正在启动，重试一次
    const retry = await sendToBackground({ type: 'BILIBAN_SCAN_START', videoRef: input, options });
    if (retry && retry.ok === false) {
      showToast('❌ ' + retry.error);
      scanStart.disabled = false;
      scanStop.disabled = true;
    }
  }
});

scanStop.addEventListener('click', async () => {
  await sendToBackground({ type: 'BILIBAN_SCAN_STOP' });
  scanStop.disabled = true;
  scanStart.disabled = false;
  showToast('⏹ 正在停止…');
});

// ==================== 评论扫描：状态同步 ====================

async function loadScanState() {
  const result = await chrome.storage.session.get('biliban_scan');
  const state = result.biliban_scan || null;
  if (state) applyScanState(state);
  return state;
}

function applyScanState(state) {
  if (!state) return;

  scanViewState.status = state.status;
  scanViewState.results = state.results || [];
  scanViewState.threads = state.threads || [];

  const running = state.status === 'running';
  scanStart.disabled = running;
  scanStop.disabled = !running;

  // 进度卡片
  if (state.status !== 'idle') scanProgress.style.display = 'block';

  if (state.video) {
    scanVideoInfo.innerHTML =
      `<div class="video-title">${escapeHtml(state.video.title || '未命名视频')}</div>` +
      `UP主：${escapeHtml(state.video.ownerName || '未知')} · ` +
      `<a href="${escapeHtml(state.video.url)}" target="_blank" style="color:#fb7299">${escapeHtml(state.video.bvid || state.video.aid)}</a>`;
  }

  const p = state.progress || { pages: 0, comments: 0 };
  // state.maxPages === 0 表示全量模式；不能用 `|| 10` 兜底，否则 0 会被吞成 10
  const unlimited = state.maxPages === 0;
  const maxPages = (!unlimited && state.maxPages) ? state.maxPages : 10; // 仅有限模式下用于百分比

  scanProgressBar.classList.remove('err', 'indeterminate');
  if (state.status === 'error') scanProgressBar.classList.add('err');
  if (unlimited && running) scanProgressBar.classList.add('indeterminate');

  let pct = 0;
  if (unlimited) {
    // 没有页数上限，无法计算百分比；完成/停止后走满
    pct = (state.status === 'done' || state.status === 'stopped') ? 100 : 0;
  } else {
    pct = (running || state.status === 'done')
      ? Math.min(100, Math.round((p.pages / maxPages) * 100))
      : 0;
  }

  // 全量模式只显示实际页数（不显示 x/10）；有限模式显示 x/y
  const pageLabel = unlimited ? `${p.pages} 页` : `${p.pages}/${maxPages} 页`;
  const rangeNote = state.timeRangeText ? ` · 时间范围 ${state.timeRangeText}` : '';

  if (state.status === 'running') {
    scanProgressText.textContent = `已抓取 ${pageLabel} · ${p.comments} 条评论 · ${scanViewState.results.length} 位用户${rangeNote}`;
    scanNote.textContent = state.note || '';
  } else if (state.status === 'done') {
    scanProgressText.textContent = `完成：共 ${pageLabel} · ${p.comments} 条评论 · ${scanViewState.results.length} 位用户${rangeNote}`;
    scanNote.textContent = state.note || '';
    scanStop.disabled = true;
    scanStart.disabled = false;
  } else if (state.status === 'stopped') {
    scanProgressText.textContent = `已停止：抓到 ${pageLabel} · ${p.comments} 条评论`;
    scanNote.textContent = state.note || '';
    scanStop.disabled = true;
    scanStart.disabled = false;
  } else if (state.status === 'error') {
    scanProgressText.textContent = '❌ 扫描出错';
    scanNote.textContent = state.error || '';
    scanStop.disabled = true;
    scanStart.disabled = false;
  }

  scanProgressBar.style.width = pct + '%';

  // 结果卡片：有用户数据即展示（含运行中/已完成/已停止/出错）
  if (scanViewState.results.length > 0 || scanViewState.threads.length > 0) {
    scanResults.style.display = 'block';
    renderScanResults();
  }
}

// ==================== 评论扫描：结果渲染（评论区复原视图） ====================

function getUidGroupMap(groups) {
  const map = new Map();
  for (const g of groups) {
    for (const uid of g.uids) {
      if (!map.has(uid)) map.set(uid, []);
      map.get(uid).push(g.name);
    }
  }
  return map;
}

// 目标分组内已有的 uid（这些用户在全选/批处理时自动锁定，避免重复添加）
function getUidsInGroup(groups, groupId) {
  const group = groups.find(g => g.id === groupId);
  return new Set(group ? group.uids : []);
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN',
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

// 把底层数据规整为评论线程列表（兼容旧 session 无 threads 字段的情况）
function getDisplayThreads() {
  const threads = scanViewState.threads || [];
  if (threads.length > 0) return threads;
  return (scanViewState.results || []).map(r => ({
    rpid: 'u_' + r.uid,
    uid: r.uid,
    uname: r.uname || '',
    avatar: r.avatar || '',
    content: r.sample || '',
    ctime: r.ctime || 0,
    replies: []
  }));
}

// 线程级命中信息：主楼或任一回复作者在黑名单即视为命中，汇总涉及的组
function annotateThread(t, uidGroupMap) {
  const authors = [t, ...(t.replies || [])].map(r => r.uid);
  const groupsSet = new Set();
  let matched = false;
  for (const uid of authors) {
    const gs = uidGroupMap.get(uid) || [];
    if (gs.length > 0) { matched = true; gs.forEach(g => groupsSet.add(g)); }
  }
  return { matched, groups: [...groupsSet] };
}

// 单条评论（主楼或回复）是否命中搜索：仅依据该条自身内容与用户名
// keywords 为空时全部命中（无搜索态）
function computeRowHit(comment, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const haystack = [comment.content || '', comment.uname || ''].join('\n').toLowerCase();
  return keywords.some(kw => haystack.includes(kw));
}

// 线程级是否命中：主楼或任一回复命中即视为命中（用于线程排序置顶/沉底）
// keywords 为空时全部命中（无搜索态）
function computeSearchHit(thread, keywords) {
  if (!keywords || keywords.length === 0) return true;
  return [thread, ...(thread.replies || [])].some(r => computeRowHit(r, keywords));
}

async function renderScanResults() {
  const groups = await BilibanStorage.getGroups();
  const uidGroupMap = getUidGroupMap(groups);
  const targetGroupId = scanBatchGroup.value;
  const lockedUids = getUidsInGroup(groups, targetGroupId);

  const searchRaw = (scanViewState.search || '').trim().toLowerCase();
  const searchKeywords = searchRaw ? searchRaw.split(/\s+/).filter(Boolean) : [];

  const allThreads = getDisplayThreads();
  const annotated = allThreads.map(t => {
    const info = annotateThread(t, uidGroupMap);
    return {
      thread: t,
      matched: info.matched,
      groups: info.groups,
      searchHit: computeSearchHit(t, searchKeywords)
    };
  });

  // 搜索排序：命中置顶（保持原序），未命中沉底（保持原序）
  const hitList = [];
  const missList = [];
  for (const x of annotated) (x.searchHit ? hitList : missList).push(x);
  const ordered = hitList.concat(missList);

  // 统计（作用于全部线程）：主楼数、涉及用户数、命中用户数
  const allUids = new Set();
  const matchedUids = new Set();
  for (const t of allThreads) {
    for (const r of [t, ...(t.replies || [])]) {
      allUids.add(r.uid);
      if ((uidGroupMap.get(r.uid) || []).length > 0) matchedUids.add(r.uid);
    }
  }
  scanResultSummary.textContent =
    `（${allThreads.length} 条主楼 · ${allUids.size} 位评论用户 · ${matchedUids.size} 位已在黑名单）`;

  if (searchKeywords.length > 0) {
    scanSearchCount.textContent = `命中 ${hitList.length} / ${allThreads.length} 条主楼`;
  } else {
    scanSearchCount.textContent = '';
  }

  // 批量分组下拉（保留当前选择；切换即重渲染来刷新锁定状态）
  const prevGroup = scanBatchGroup.value;
  scanBatchGroup.innerHTML = groups.length === 0
    ? '<option value="">请先创建分组</option>'
    : groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  scanBatchGroup.value = prevGroup;

  if (ordered.length === 0) {
    scanResultList.innerHTML = '<div class="result-empty">暂无可展示的评论</div>';
    scanSelectAll.checked = false;
    updateSelectAllState();
    return;
  }

  // 每个 uid 的展示元信息
  const uidMeta = new Map();
  for (const t of allThreads) {
    for (const r of [t, ...(t.replies || [])]) {
      if (!uidMeta.has(r.uid)) {
        uidMeta.set(r.uid, {
          groups: uidGroupMap.get(r.uid) || [],
          locked: lockedUids.has(r.uid)
        });
      }
    }
  }
  const uidInfo = (uid) => uidMeta.get(uid) || { groups: [], locked: false };

  const rowHtml = (r, isReply, isMuted) => {
    const meta = uidInfo(r.uid);
    const locked = meta.locked;
    const isIgnored = scanViewState.ignored.has(r.uid);
    const isAdded = scanViewState.added.has(r.uid);
    const isSelected = scanViewState.selected.has(r.uid);

    const badges = [];
    if (isMuted) badges.push('<span class="thread-badge muted">未命中搜索</span>');
    if (locked) badges.push('<span class="thread-badge locked">🔒 已在目标分组</span>');
    if (isIgnored) badges.push('<span class="thread-badge ignored">已忽略</span>');
    if (isAdded) badges.push('<span class="thread-badge added">已加入黑名单</span>');
    meta.groups.forEach(g => {
      badges.push(`<span class="thread-badge">${escapeHtml(g)}</span>`);
    });

    // 锁定（已在目标分组）或已忽略：checkbox 禁用，不参与全选/批量。
    // 未命中搜索的灰显行【不禁用】——全选时不选它，但可手动勾选加入。
    const checkDisabled = (locked || isIgnored) ? 'disabled' : '';
    const checked = (!checkDisabled && isSelected) ? 'checked' : '';

    return `
      <div class="thread-row${isMuted ? ' muted' : ''}">
        <input type="checkbox" class="thread-check" data-uid="${r.uid}" ${checked} ${checkDisabled}
               title="${locked ? '该用户已在选中的目标分组中，已自动锁定避免重复添加' : (isIgnored ? '该评论已被忽略' : (isMuted ? '该评论未命中搜索词（已置灰），全选时会跳过，可手动勾选' : ''))}">
        ${r.avatar
          ? `<img class="thread-avatar${isReply ? ' sm' : ''}" src="${escapeHtml(r.avatar)}" referrerpolicy="no-referrer" alt="">`
          : `<div class="thread-avatar${isReply ? ' sm' : ''}"></div>`}
        <div class="thread-main">
          <div class="thread-meta">
            <a class="thread-uname" href="https://space.bilibili.com/${r.uid}" target="_blank">${escapeHtml(r.uname || '未知用户')}</a>
            <span class="thread-uid">UID ${r.uid}</span>
            ${r.ctime ? `<span class="thread-time">${formatTime(r.ctime)}</span>` : ''}
            ${badges.length ? `<div class="thread-badges">${badges.join('')}</div>` : ''}
          </div>
          <div class="thread-content">${r.content ? escapeHtml(r.content) : '（无文本评论）'}</div>
        </div>
        <div class="thread-actions">
          ${!locked && !isAdded ? `<button class="thread-btn add" data-action="add" data-uid="${r.uid}">➕ 加入</button>` : ''}
          ${!locked ? `<button class="thread-btn ignore" data-action="ignore" data-uid="${r.uid}">${isIgnored ? '取消忽略' : '忽略'}</button>` : ''}
        </div>
      </div>`;
  };

  scanResultList.innerHTML = ordered.map(({ thread }) => {
    // 行级命中判定：主楼与每条回复各自独立计算（保证精准匹配，未命中的行灰显禁用）
    const mainMuted = !computeRowHit(thread, searchKeywords);
    const mainRow = rowHtml(thread, false, mainMuted);
    const replies = (thread.replies || []).map(s => rowHtml(s, true, !computeRowHit(s, searchKeywords))).join('');
    return `
      <div class="thread-card ${scanViewState.ignored.has(thread.uid) ? 'ignored' : ''}" data-rpid="${thread.rpid}">
        ${mainRow}
        ${replies ? `<div class="thread-replies">${replies}</div>` : ''}
      </div>`;
  }).join('');

  // 绑定行内事件
  scanResultList.querySelectorAll('.thread-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const uid = Number(cb.dataset.uid);
      if (cb.checked) scanViewState.selected.add(uid);
      else scanViewState.selected.delete(uid);
      updateSelectAllState();
    });
  });
  scanResultList.querySelectorAll('.thread-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = Number(btn.dataset.uid);
      if (btn.dataset.action === 'add') {
        await addSingleUser(uid);
      } else if (btn.dataset.action === 'ignore') {
        if (scanViewState.ignored.has(uid)) {
          scanViewState.ignored.delete(uid);
        } else {
          scanViewState.ignored.add(uid);
          scanViewState.selected.delete(uid);
        }
        renderScanResults();
      }
    });
  });

  // 「整行点击勾选」：开启后点击主楼/回复行即可勾选（无需精确点小框框）。
  // 点击用户名链接（跳主页）、操作按钮、checkbox 自身或禁用行时不触发。
  if (scanRowClick.checked) {
    scanResultList.querySelectorAll('.thread-row').forEach(row => {
      row.classList.add('row-clickable');
      row.addEventListener('click', (e) => {
        if (e.target.closest('.thread-check')) return; // 点 checkbox 自身，交给 change 事件
        if (e.target.closest('.thread-uname')) return; // 点用户名跳主页，不打勾
        if (e.target.closest('.thread-btn')) return;   // 点操作按钮
        const cb = row.querySelector('.thread-check');
        if (!cb || cb.disabled) return;                // 禁用行（锁定/已忽略）不响应
        cb.checked = !cb.checked;
        const uid = Number(cb.dataset.uid);
        if (cb.checked) scanViewState.selected.add(uid);
        else scanViewState.selected.delete(uid);
        updateSelectAllState();
      });
    });
  }
  updateSelectAllState();
}

function updateSelectAllState() {
  // 全选状态只统计「搜索命中行」的 checkbox（.thread-row 不带 .muted）且未禁用。
  // 未命中搜索的灰显行可手动勾选，但不计入全选状态，也不会被全选按钮批量勾选。
  const checks = [...document.querySelectorAll('.thread-row:not(.muted) .thread-check')].filter(cb => !cb.disabled);
  const checked = checks.filter(cb => cb.checked).length;
  scanSelectAll.checked = checks.length > 0 && checked === checks.length;
  scanSelectAll.indeterminate = checked > 0 && checked < checks.length;
  const disabledCount = document.querySelectorAll('.thread-check:disabled').length;
  const mutedCount = document.querySelectorAll('.thread-row.muted').length;
  scanBatchHint.textContent = scanViewState.selected.size > 0
    ? `已选 ${scanViewState.selected.size} 位用户${disabledCount ? ` · ${disabledCount} 项不可选（已锁定/已忽略）` : ''}`
    : (mutedCount ? `${mutedCount} 条未命中搜索已置灰 · 全选会自动跳过，需要的话可手动勾选加入` : '');
}

scanSelectAll.addEventListener('change', () => {
  // 全选：只勾选「搜索命中的行」（.thread-row 不带 .muted）；未锁定、未忽略。
  // 未命中搜索的灰显行不会被全选批量勾选（可手动勾选），但取消全选时一并清除，避免误加。
  const hitChecks = [...document.querySelectorAll('.thread-row:not(.muted) .thread-check')]
    .filter(cb => !cb.disabled)
    .map(cb => Number(cb.dataset.uid));
  if (scanSelectAll.checked) {
    hitChecks.forEach(uid => scanViewState.selected.add(uid));
  } else {
    // 取消全选：清空当前所有已勾选（含手动勾选的灰显行）
    [...document.querySelectorAll('.thread-check:checked')]
      .forEach(cb => scanViewState.selected.delete(Number(cb.dataset.uid)));
  }
  renderScanResults();
});

// 评论搜索：输入防抖后重渲染（命中置顶、未命中灰显沉底）
let searchDebounce = null;
scanSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    scanViewState.search = scanSearchInput.value;
    if (scanResults.style.display !== 'none') renderScanResults();
  }, 200);
});

// 切换批量加入的目标分组时，锁定集合随目标分组变化，立即重渲染
scanBatchGroup.addEventListener('change', () => {
  scanViewState.selected.clear(); // 目标变化后清空选择，避免误加
  if (scanResults.style.display !== 'none') renderScanResults();
});

// 单个加入
async function addSingleUser(uid) {
  const groups = await BilibanStorage.getGroups();
  if (groups.length === 0) { showToast('请先创建分组'); return; }

  const result = await showModal('加入黑名单', `
    <p>将用户 <strong>UID ${uid}</strong> 加入：</p>
    <select id="single-add-group">
      ${groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
    </select>`, async () => {
    const groupId = document.getElementById('single-add-group')?.value;
    if (!groupId) return null;
    const res = await BilibanStorage.addUidToGroup(groupId, uid);
    return res;
  });

  if (result && result.ok) {
    scanViewState.added.add(uid);
    scanViewState.selected.delete(uid);
    renderScanResults();
    showToast(`✅ 已加入「${result.groupName}」`);
  }
}

// 批量加入
scanBatchAdd.addEventListener('click', async () => {
  const groupId = scanBatchGroup.value;
  if (!groupId) { showToast('请先创建/选择一个分组'); return; }
  if (scanViewState.selected.size === 0) { showToast('请先勾选要加入的用户'); return; }

  const groups = await BilibanStorage.getGroups();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  // 过滤已忽略 + 已在目标分组（锁定）的用户；选中集合理论上已排除，这里双保险
  const groupsNow = await BilibanStorage.getGroups();
  const lockedNow = getUidsInGroup(groupsNow, groupId);
  const uids = Array.from(scanViewState.selected).filter(uid =>
    !scanViewState.ignored.has(uid) && !lockedNow.has(uid)
  );
  if (uids.length === 0) { showToast('选中的用户均已在目标分组或已被忽略'); return; }

  const result = await showModal('批量加入黑名单',
    `<p>将 <strong>${uids.length}</strong> 位用户加入分组「<strong>${escapeHtml(group.name)}</strong>」？</p>
     <p style="margin-top:8px;color:#888">已在该分组中的用户会自动跳过</p>`,
    async () => {
      const res = await BilibanStorage.addUidsToGroup(groupId, uids);
      return res;
    }, '批量加入');

  if (result) {
    uids.forEach(uid => {
      scanViewState.added.add(uid);
      scanViewState.selected.delete(uid);
    });
    renderScanResults();
    showToast(`✅ 已加入 ${result.added} 位，跳过 ${result.skipped} 位（已在组内）`);
  }
});

// 批量忽略
scanBatchIgnore.addEventListener('click', () => {
  scanViewState.selected.forEach(uid => scanViewState.ignored.add(uid));
  scanViewState.selected.clear();
  renderScanResults();
  showToast('已忽略选中的用户');
});

async function renderScanBatchGroupOptions() {
  const groups = await BilibanStorage.getGroups();
  scanBatchGroup.innerHTML = groups.length === 0
    ? '<option value="">请先创建分组</option>'
    : groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
}

// ==================== 监听扫描状态推送 ====================

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'BILIBAN_SCAN_UPDATE') {
    if (msg.state) applyScanState(msg.state);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.biliban_scan) {
    const state = changes.biliban_scan.newValue;
    if (state) applyScanState(state);
  }
});

// ==================== 初始化 ====================

async function init() {
  await render();
  await loadScanSettings();
  await loadScanState();
}

init();