// ==================== DOM 元素 ====================
const inputUid = document.getElementById('input-uid');
const selectGroup = document.getElementById('select-group');
const btnAdd = document.getElementById('btn-add');
const errorMsg = document.getElementById('error-msg');
const groupsContainer = document.getElementById('groups-container');
const btnAddGroup = document.getElementById('btn-add-group');
const statsEl = document.getElementById('stats');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const fileImport = document.getElementById('file-import');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

// GitHub 相关
const btnPower = document.getElementById('btn-power');
const btnGithub = document.getElementById('btn-github');
const githubPanel = document.getElementById('github-panel');
const githubClose = document.getElementById('github-close');
const githubTabs = document.querySelectorAll('.github-tab');
const githubTokenInput = document.getElementById('github-token-input');
const githubTokenSave = document.getElementById('github-token-save');
const githubTokenStatus = document.getElementById('github-token-status');
const githubSyncSection = document.getElementById('github-sync-section');
const githubUserInfo = document.getElementById('github-user-info');
const githubPush = document.getElementById('github-push');
const githubPull = document.getElementById('github-pull');
const githubSyncStatus = document.getElementById('github-sync-status');
const githubLink = document.getElementById('github-link');
const githubLinkUrl = document.getElementById('github-link-url');

// 分块相关
const btnAddChunk = document.getElementById('btn-add-chunk');
const chunkList = document.getElementById('chunk-list');
const btnPushSelected = document.getElementById('btn-push-selected');
const btnPullSelected = document.getElementById('btn-pull-selected');
const chunkSyncStatus = document.getElementById('chunk-sync-status');
const chunkModalOverlay = document.getElementById('chunk-modal-overlay');
const chunkModalTitle = document.getElementById('chunk-modal-title');
const chunkModalBody = document.getElementById('chunk-modal-body');
const chunkModalClose = document.getElementById('chunk-modal-close');
const chunkModalCancel = document.getElementById('chunk-modal-cancel');
const chunkModalConfirm = document.getElementById('chunk-modal-confirm');

// 订阅相关
const sourceInput = document.getElementById('source-input');
const sourceAdd = document.getElementById('source-add');
const sourceAddStatus = document.getElementById('source-add-status');
const sourcePullAll = document.getElementById('source-pull-all');
const sourcePullStatus = document.getElementById('source-pull-status');
const sourceCount = document.getElementById('source-count');
const sourceList = document.getElementById('source-list');

// ==================== 拖拽排序相关变量 ====================
let draggedCard = null;
let draggedGroupId = null;

// ==================== 分块选择状态 ====================
let selectedChunkIds = new Set();

// ==================== 工具函数 ====================

function showError(msg) {
  errorMsg.textContent = msg;
  setTimeout(() => { errorMsg.textContent = ''; }, 3000);
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

function showChunkModal(title, bodyHTML, onConfirm) {
  chunkModalTitle.textContent = title;
  chunkModalBody.innerHTML = bodyHTML;
  chunkModalOverlay.style.display = 'flex';
  return new Promise((resolve) => {
    chunkModalConfirm.onclick = () => { chunkModalOverlay.style.display = 'none'; resolve(onConfirm()); };
    chunkModalCancel.onclick = () => { chunkModalOverlay.style.display = 'none'; resolve(null); };
    chunkModalClose.onclick = () => { chunkModalOverlay.style.display = 'none'; resolve(null); };
  });
}

// ==================== 渲染 ====================

async function render() {
  const expandedIds = new Set();
  document.querySelectorAll('.group-card.expanded').forEach(c => expandedIds.add(c.dataset.groupId));

  const groups = await BilibanStorage.getGroups();
  const chunks = await BilibanStorage.getChunks();
  const expandState = await BilibanStorage.getChunkExpandState();

  selectGroup.innerHTML = groups.length === 0
    ? '<option value="">请先创建分组</option>'
    : groups.map(g => {
        const chunk = chunks.find(c => c.id === g.chunkId);
        const chunkLabel = chunk ? ` [${chunk.name}]` : '';
        return `<option value="${g.id}">${g.name}${chunkLabel}</option>`;
      }).join('');

  groupsContainer.innerHTML = '';

  if (groups.length === 0) {
    groupsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">还没有屏蔽分组<br>点击下方按钮创建第一个分组</div>
      </div>`;
  } else {
    // 按块分组显示
    const groupsByChunk = new Map();
    groupsByChunk.set(null, []); // 未分组的
    
    for (const group of groups) {
      const chunkId = group.chunkId || null;
      if (!groupsByChunk.has(chunkId)) {
        groupsByChunk.set(chunkId, []);
      }
      groupsByChunk.get(chunkId).push(group);
    }

    // 渲染每个块
    for (const [chunkId, chunkGroups] of groupsByChunk) {
      if (chunkGroups.length === 0) continue;

      const chunk = chunkId ? chunks.find(c => c.id === chunkId) : null;
      const chunkName = chunk ? chunk.name : '未分组';
      const stateKey = chunkId || '_ungrouped';
      const isExpanded = expandState[stateKey] !== false; // 默认展开
      
      // 块容器
      const chunkContainer = document.createElement('div');
      chunkContainer.className = 'chunk-group-container';
      chunkContainer.dataset.chunkId = stateKey;
      
      // 块标题
      const chunkHeader = document.createElement('div');
      chunkHeader.className = 'chunk-group-header' + (isExpanded ? ' expanded' : '');
      chunkHeader.innerHTML = `
        <div class="chunk-group-left">
          <span class="chunk-group-expand">▶</span>
          <span class="chunk-group-name">${chunkName}</span>
          <span class="chunk-group-count">${chunkGroups.length} 个分组</span>
        </div>
      `;
      
      // 点击展开收起
      chunkHeader.addEventListener('click', async () => {
        const nowExpanded = !chunkHeader.classList.contains('expanded');
        chunkHeader.classList.toggle('expanded', nowExpanded);
        await BilibanStorage.setChunkExpandState(stateKey, nowExpanded);
      });
      
      chunkContainer.appendChild(chunkHeader);
      
      // 块内容容器（展开收起由 CSS `.chunk-group-header.expanded + .chunk-group-body` 控制）
      const chunkBody = document.createElement('div');
      chunkBody.className = 'chunk-group-body';

      // 渲染该块下的分组
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

        const chunkBadge = chunk ? `<span class="group-chunk-badge">${chunk.name}</span>` : '';

        card.innerHTML = `
          <div class="group-header">
            <div class="drag-handle" data-group-id="${group.id}" title="拖拽排序">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
              </svg>
            </div>
            <div class="group-toggle ${group.enabled ? 'active' : ''}" data-group-id="${group.id}"></div>
            <div class="group-name" data-group-id="${group.id}">${group.name}</div>
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
          </div>`;

        chunkBody.appendChild(card);
        if (expandedIds.has(group.id)) card.classList.add('expanded');
      }
      
      chunkContainer.appendChild(chunkBody);
      groupsContainer.appendChild(chunkContainer);
    }
  }

  let totalUids = new Set();
  for (const g of groups) g.uids.forEach(uid => totalUids.add(uid));
  statsEl.textContent = `${groups.length} 个分组 · ${totalUids.size} 个用户`;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll('.group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.group-toggle') || e.target.closest('.group-action-btn') || e.target.closest('.drag-handle')) return;
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

  document.querySelectorAll('.group-action-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const groupId = btn.dataset.groupId;

      if (action === 'delete') {
        const result = await showModal('删除分组', '<p>确定要删除这个分组吗？组内用户将被一并移除。</p>',
          async () => { await BilibanStorage.removeGroup(groupId); });
        if (result !== null) render();
      }

      if (action === 'rename') {
        const groups = await BilibanStorage.getGroups();
        const group = groups.find(g => g.id === groupId);
        const result = await showModal('重命名分组',
          `<p>输入新的分组名称：</p><input type="text" id="rename-input" value="${group.name}">`,
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

  // 绑定拖拽排序事件
  bindDragEvents();
}

// ==================== 拖拽排序功能 ====================

function bindDragEvents() {
  const dragHandles = document.querySelectorAll('.drag-handle');
  
  dragHandles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const card = handle.closest('.group-card');
      draggedCard = card;
      draggedGroupId = handle.dataset.groupId;
      
      // 添加拖拽样式
      card.classList.add('dragging');
      
      // 设置拖拽图像
      const dragImage = card.cloneNode(true);
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      dragImage.style.opacity = '0.8';
      dragImage.style.width = card.offsetWidth + 'px';
      document.body.appendChild(dragImage);
      
      // 创建自定义拖拽事件
      const startX = e.clientX;
      const startY = e.clientY;
      const cardRect = card.getBoundingClientRect();
      const offsetX = startX - cardRect.left;
      const offsetY = startY - cardRect.top;
      
      const onMouseMove = (moveEvent) => {
        const x = moveEvent.clientX - offsetX;
        const y = moveEvent.clientY - offsetY;
        
        // 查找目标卡片
        const targetCard = findTargetCard(moveEvent.clientX, moveEvent.clientY);
        
        // 清除所有 drag-over 样式
        document.querySelectorAll('.group-card.drag-over').forEach(c => {
          c.classList.remove('drag-over');
        });
        
        // 添加 drag-over 样式到目标卡片
        if (targetCard && targetCard !== draggedCard) {
          targetCard.classList.add('drag-over');
        }
      };
      
      const onMouseUp = async (upEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        
        // 移除拖拽图像
        document.body.removeChild(dragImage);
        
        // 查找目标卡片
        const targetCard = findTargetCard(upEvent.clientX, upEvent.clientY);
        
        if (targetCard && targetCard !== draggedCard) {
          const targetGroupId = targetCard.dataset.groupId;
          
          // 获取当前所有分组
          const groups = await BilibanStorage.getGroups();
          const groupIds = groups.map(g => g.id);
          
          // 找到拖拽源和目标的索引
          const fromIndex = groupIds.indexOf(draggedGroupId);
          const toIndex = groupIds.indexOf(targetGroupId);
          
          if (fromIndex !== -1 && toIndex !== -1) {
            // 重新排列数组
            const [movedGroup] = groupIds.splice(fromIndex, 1);
            groupIds.splice(toIndex, 0, movedGroup);
            
            // 保存新的顺序
            await BilibanStorage.reorderGroups(groupIds);
            
            // 重新渲染
            render();
            showToast('✅ 分组顺序已更新');
          }
        }
        
        // 清除所有样式
        document.querySelectorAll('.group-card').forEach(c => {
          c.classList.remove('dragging', 'drag-over');
        });
        
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

// ==================== 分块管理功能 ====================

async function renderChunks() {
  const chunks = await BilibanStorage.getChunks();
  const groups = await BilibanStorage.getGroups();
  
  if (chunks.length === 0) {
    chunkList.innerHTML = '<div class="chunk-empty">暂无分块，点击上方按钮创建</div>';
    return;
  }

  chunkList.innerHTML = chunks.map(chunk => {
    const chunkGroups = groups.filter(g => g.chunkId === chunk.id);
    const totalUids = chunkGroups.reduce((sum, g) => sum + g.uids.length, 0);
    const isSelected = selectedChunkIds.has(chunk.id);
    
    return `
      <div class="chunk-item" data-chunk-id="${chunk.id}">
        <input type="checkbox" class="chunk-checkbox" data-chunk-id="${chunk.id}" ${isSelected ? 'checked' : ''}>
        <div class="chunk-info">
          <div class="chunk-name">${chunk.name}</div>
          <div class="chunk-meta">${chunkGroups.length} 个分组 · ${totalUids} 个用户</div>
        </div>
        <div class="chunk-actions-inline">
          <button class="chunk-action-btn" data-action="edit" data-chunk-id="${chunk.id}" title="编辑">✏️</button>
          <button class="chunk-action-btn delete" data-action="delete" data-chunk-id="${chunk.id}" title="删除">🗑️</button>
        </div>
      </div>`;
  }).join('');

  // 绑定事件
  chunkList.querySelectorAll('.chunk-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        selectedChunkIds.add(cb.dataset.chunkId);
      } else {
        selectedChunkIds.delete(cb.dataset.chunkId);
      }
      updateChunkButtons();
    });
  });

  chunkList.querySelectorAll('.chunk-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const chunkId = btn.dataset.chunkId;

      if (action === 'edit') {
        await showEditChunkDialog(chunkId);
      }

      if (action === 'delete') {
        const result = await showModal('删除分块', '<p>确定要删除这个块吗？块内的分组不会被删除，只会取消分组归属。</p>',
          async () => { await BilibanStorage.removeChunk(chunkId); });
        if (result !== null) {
          selectedChunkIds.delete(chunkId);
          await renderChunks();
          render();
        }
      }
    });
  });

  updateChunkButtons();
}

function updateChunkButtons() {
  const hasSelection = selectedChunkIds.size > 0;
  btnPushSelected.disabled = !hasSelection;
  btnPullSelected.disabled = !hasSelection;
}

// 创建新块
btnAddChunk.addEventListener('click', async () => {
  const groups = await BilibanStorage.getGroups();
  const result = await showChunkModal('创建新块', `
    <label>块名称</label>
    <input type="text" id="chunk-name-input" placeholder="如：广告号、杠精...">
    <label style="margin-top:12px">选择分组（可选）</label>
    <div class="group-assign-list">
      ${groups.map(g => `
        <div class="group-assign-item">
          <input type="checkbox" class="group-assign-checkbox" data-group-id="${g.id}">
          <span class="group-assign-name">${g.name}</span>
          <span class="group-assign-count">${g.uids.length} 人</span>
        </div>
      `).join('')}
    </div>
  `, async () => {
    const name = document.getElementById('chunk-name-input').value.trim();
    if (!name) return null;

    const chunk = await BilibanStorage.addChunk(name);
    
    // 分配选中的分组到新块
    const checkboxes = document.querySelectorAll('.group-assign-checkbox:checked');
    for (const cb of checkboxes) {
      await BilibanStorage.moveGroupToChunk(cb.dataset.groupId, chunk.id);
    }

    return chunk;
  });

  if (result !== null) {
    await renderChunks();
    render();
    showToast('✅ 块「' + result.name + '」已创建');
  }
});

// 编辑块
async function showEditChunkDialog(chunkId) {
  const chunks = await BilibanStorage.getChunks();
  const chunk = chunks.find(c => c.id === chunkId);
  if (!chunk) return;

  const groups = await BilibanStorage.getGroups();
  const chunkGroups = groups.filter(g => g.chunkId === chunkId);

  const result = await showChunkModal('编辑块', `
    <label>块名称</label>
    <input type="text" id="chunk-name-input" value="${chunk.name}">
    <label style="margin-top:12px">包含的分组</label>
    <div class="group-assign-list">
      ${groups.map(g => `
        <div class="group-assign-item">
          <input type="checkbox" class="group-assign-checkbox" data-group-id="${g.id}" 
            ${g.chunkId === chunkId ? 'checked' : ''}>
          <span class="group-assign-name">${g.name}</span>
          <span class="group-assign-count">${g.uids.length} 人</span>
        </div>
      `).join('')}
    </div>
  `, async () => {
    const newName = document.getElementById('chunk-name-input').value.trim();
    if (!newName) return null;

    await BilibanStorage.renameChunk(chunkId, newName);

    // 更新分组归属
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

  if (result !== null) {
    await renderChunks();
    render();
    showToast('✅ 块已更新');
  }
}

// 移动分组到块
async function showMoveGroupDialog(groupId) {
  const chunks = await BilibanStorage.getChunks();
  const groups = await BilibanStorage.getGroups();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  const result = await showModal('移动到块', `
    <p>将「${group.name}」移动到：</p>
    <div style="margin-top:12px">
      <label style="display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;border-radius:6px;background:#404040;margin-bottom:4px">
        <input type="radio" name="move-chunk" value="" ${!group.chunkId ? 'checked' : ''}>
        <span>未分组</span>
      </label>
      ${chunks.map(c => `
        <label style="display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;border-radius:6px;background:#404040;margin-bottom:4px">
          <input type="radio" name="move-chunk" value="${c.id}" ${group.chunkId === c.id ? 'checked' : ''}>
          <span>${c.name}</span>
        </label>
      `).join('')}
    </div>
  `, async () => {
    const selectedChunk = document.querySelector('input[name="move-chunk"]:checked');
    const chunkId = selectedChunk ? selectedChunk.value || null : null;
    await BilibanStorage.moveGroupToChunk(groupId, chunkId);
    return true;
  });

  if (result !== null) {
    render();
    showToast('✅ 分组已移动');
  }
}

// 推送选中的块
btnPushSelected.addEventListener('click', async () => {
  if (selectedChunkIds.size === 0) return;

  btnPushSelected.disabled = true;
  chunkSyncStatus.textContent = '推送中...';
  chunkSyncStatus.className = 'github-hint github-status-loading';

  try {
    const chunks = await BilibanStorage.getChunks();
    const results = [];

    for (const chunkId of selectedChunkIds) {
      const chunk = chunks.find(c => c.id === chunkId);
      if (!chunk) continue;

      const chunkData = await BilibanStorage.getChunkData(chunkId);
      const result = await BilibanGithubSync.pushChunk(chunk.name, chunkData);
      results.push(result);
    }

    chunkSyncStatus.textContent = `✓ 已推送 ${results.length} 个块`;
    chunkSyncStatus.className = 'github-hint github-status-ok';
    showToast(`✅ 已推送 ${results.length} 个块到云端`);
  } catch (e) {
    chunkSyncStatus.textContent = '✗ ' + e.message;
    chunkSyncStatus.className = 'github-hint github-status-err';
  }

  btnPushSelected.disabled = false;
});

// 拉取选中的块
btnPullSelected.addEventListener('click', async () => {
  if (selectedChunkIds.size === 0) return;

  const chunks = await BilibanStorage.getChunks();
  const selectedChunks = chunks.filter(c => selectedChunkIds.has(c.id));
  
  const result = await showModal('拉取选中块', `
    <p>将从云端拉取以下块并<strong>覆盖</strong>本地对应块的分组：</p>
    <ul style="margin-top:8px;padding-left:20px">
      ${selectedChunks.map(c => `<li>${c.name}</li>`).join('')}
    </ul>
    <p style="margin-top:12px;color:#ff4d4f">⚠️ 这将替换本地这些块下的所有分组数据</p>
  `, async () => {
    btnPullSelected.disabled = true;
    chunkSyncStatus.textContent = '拉取中...';
    chunkSyncStatus.className = 'github-hint github-status-loading';

    try {
      const results = [];

      for (const chunk of selectedChunks) {
        try {
          const pullResult = await BilibanGithubSync.pullChunk(chunk.name);
          await BilibanStorage.importChunkData(pullResult.data, chunk.id, 'replace');
          results.push(chunk.name);
        } catch (e) {
          console.error(`拉取块 ${chunk.name} 失败:`, e);
        }
      }

      chunkSyncStatus.textContent = `✓ 已拉取 ${results.length} 个块`;
      chunkSyncStatus.className = 'github-hint github-status-ok';
      showToast(`✅ 已拉取 ${results.length} 个块`);
      render();
    } catch (e) {
      chunkSyncStatus.textContent = '✗ ' + e.message;
      chunkSyncStatus.className = 'github-hint github-status-err';
    }

    btnPullSelected.disabled = false;
  });
});

// ==================== 添加用户 ====================

btnAdd.addEventListener('click', async () => {
  const uid = parseInt(inputUid.value.trim(), 10);
  const groupId = selectGroup.value;
  if (!uid || isNaN(uid) || uid <= 0) { showError('请输入有效的 UID（纯数字）'); return; }
  if (!groupId) { showError('请先选择或创建一个分组'); return; }
  const result = await BilibanStorage.addUidToGroup(groupId, uid);
  if (result.ok) { inputUid.value = ''; render(); }
  else if (result.reason === 'duplicate') { showError('该用户已在「' + (result.groupName || '该分组') + '」中'); }
  else { showError('添加失败，请重试'); }
});
inputUid.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnAdd.click(); });

// ==================== 新建分组 ====================

btnAddGroup.addEventListener('click', async () => {
  const chunks = await BilibanStorage.getChunks();
  const result = await showModal('新建分组',
    `<p>输入分组名称：</p>
     <input type="text" id="new-group-name" placeholder="如：杠精、广告号...">
     <p style="margin-top:12px">选择所属块（可选）：</p>
     <select id="new-group-chunk" style="width:100%;height:34px;padding:0 8px;border:1.5px solid #555;border-radius:6px;font-size:13px;background:#404040;color:#e0e0e0;outline:none;margin-top:8px">
       <option value="">不分配块</option>
       ${chunks.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
     </select>`,
    async () => {
      const input = document.getElementById('new-group-name');
      const chunkSelect = document.getElementById('new-group-chunk');
      if (input.value.trim()) {
        const group = await BilibanStorage.addGroup(input.value.trim(), chunkSelect.value || null);
        return group;
      }
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
  a.download = `biliban_blacklist_${new Date().toISOString().slice(0,10)}.json`;
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
  } catch { showError('文件格式无效'); fileImport.value = ''; return; }

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
  if (result !== null) render();
});

// ==================== GitHub 面板 ====================

btnGithub.addEventListener('click', async () => {
  const isVisible = githubPanel.style.display !== 'none';
  githubPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    const token = await BilibanGithubSync.getToken();
    if (token) {
      githubTokenInput.value = token;
      await checkGithubToken();
    }
    await renderSources();
  }
});

githubClose.addEventListener('click', () => { githubPanel.style.display = 'none'; });

// Tab 切换
githubTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    githubTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const tabName = tab.dataset.tab;
    document.getElementById('tab-sync').style.display = tabName === 'sync' ? 'block' : 'none';
    document.getElementById('tab-subscribe').style.display = tabName === 'subscribe' ? 'block' : 'none';
  });
});

// Token 验证
async function checkGithubToken() {
  const token = githubTokenInput.value.trim();
  if (!token) { githubTokenStatus.textContent = '请输入 Token'; githubTokenStatus.className = 'github-hint github-status-err'; return; }
  githubTokenStatus.textContent = '验证中...'; githubTokenStatus.className = 'github-hint github-status-loading';
  await BilibanGithubSync.setToken(token);
  const result = await BilibanGithubSync.validateToken();
  if (result.valid) {
    githubTokenStatus.textContent = '✓ 已连接: ' + result.username;
    githubTokenStatus.className = 'github-hint github-status-ok';
    githubSyncSection.style.display = 'block';
    githubUserInfo.textContent = '👤 ' + result.username;
    
    // 渲染分块列表
    await renderChunks();
    
    const status = await BilibanGithubSync.getSyncStatus();
    if (status.synced) {
      githubSyncStatus.textContent = status.message || '上次同步: ' + new Date(status.updatedAt).toLocaleString();
      githubSyncStatus.className = 'github-hint github-status-ok';
      githubLink.style.display = 'block';
      if (status.chunks && status.chunks.length > 0) {
        githubLinkUrl.href = status.chunks[0].url;
      }
    } else {
      githubSyncStatus.textContent = status.reason || '未同步'; githubSyncStatus.className = 'github-hint';
      githubLink.style.display = 'none';
    }
  } else {
    githubTokenStatus.textContent = '✗ ' + result.error;
    githubTokenStatus.className = 'github-hint github-status-err';
    githubSyncSection.style.display = 'none';
  }
}
githubTokenSave.addEventListener('click', checkGithubToken);

// 推送全部
githubPush.addEventListener('click', async () => {
  githubPush.disabled = true; githubSyncStatus.textContent = '推送中...';
  githubSyncStatus.className = 'github-hint github-status-loading';
  try {
    const data = await BilibanStorage._load();
    const result = await BilibanGithubSync.push(data);
    githubSyncStatus.textContent = '✓ ' + result.message;
    githubSyncStatus.className = 'github-hint github-status-ok';
    githubLink.style.display = 'block'; githubLinkUrl.href = result.url;
  } catch (e) {
    githubSyncStatus.textContent = '✗ ' + e.message;
    githubSyncStatus.className = 'github-hint github-status-err';
  }
  githubPush.disabled = false;
});

// 拉取全部
githubPull.addEventListener('click', async () => {
  const result = await showModal('从云端恢复', '<p>这将用云端数据<strong>覆盖</strong>本地黑名单。确定继续？</p>',
    async () => {
      githubPull.disabled = true;
      try {
        const pullResult = await BilibanGithubSync.pull();
        await BilibanStorage._save(pullResult.data);
        githubSyncStatus.textContent = '✓ 恢复成功';
        githubSyncStatus.className = 'github-hint github-status-ok';
        render();
      } catch (e) {
        githubSyncStatus.textContent = '✗ ' + e.message;
        githubSyncStatus.className = 'github-hint github-status-err';
      }
      githubPull.disabled = false;
    });
});

// ==================== 订阅源管理 ====================

// 解析用户输入的仓库地址
function parseSourceInput(input) {
  input = input.trim();
  // 完整 URL: https://github.com/owner/repo/blob/main/path/to/file.json
  let m = input.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3], path: m[4] };

  // 简短 URL: https://github.com/owner/repo
  m = input.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (m) return { owner: m[1], repo: m[2], branch: 'main', path: 'blacklist.json' };

  // owner/repo/path.json
  m = input.match(/^([^/]+)\/([^/]+)\/(.+\.json)$/);
  if (m) return { owner: m[1], repo: m[2], branch: 'main', path: m[3] };

  // owner/repo
  m = input.match(/^([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2], branch: 'main', path: 'blacklist.json' };

  return null;
}

sourceAdd.addEventListener('click', async () => {
  const parsed = parseSourceInput(sourceInput.value);
  if (!parsed) {
    sourceAddStatus.textContent = '格式无效，请输入 owner/repo 或 GitHub URL';
    sourceAddStatus.className = 'github-hint github-status-err';
    return;
  }

  sourceAddStatus.textContent = '添加中...';
  sourceAddStatus.className = 'github-hint github-status-loading';

  try {
    // 验证文件是否存在
    const url = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${parsed.path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('文件不存在或仓库不可访问 (' + resp.status + ')');

    // 尝试获取仓库的块列表
    const chunks = await BilibanStorage.fetchSourceChunks(parsed);
    parsed.chunks = chunks;

    await BilibanStorage.addSource(parsed);
    sourceInput.value = '';
    sourceAddStatus.textContent = '✓ 添加成功';
    sourceAddStatus.className = 'github-hint github-status-ok';
    await renderSources();
  } catch (e) {
    sourceAddStatus.textContent = '✗ ' + e.message;
    sourceAddStatus.className = 'github-hint github-status-err';
  }
});

sourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sourceAdd.click(); });

// 从全部源拉取
sourcePullAll.addEventListener('click', async () => {
  const sources = await BilibanStorage.getSources();
  if (sources.length === 0) {
    sourcePullStatus.textContent = '请先添加订阅源';
    sourcePullStatus.className = 'github-hint github-status-err';
    return;
  }

  sourcePullAll.disabled = true;
  sourcePullStatus.textContent = '拉取中...';
  sourcePullStatus.className = 'github-hint github-status-loading';

  try {
    const result = await BilibanStorage.mergeSourcesIntoLocal();
    let msg = `✓ 从 ${result.results} 个源拉取，合并 ${result.merged} 个新 UID`;
    if (result.errors.length > 0) {
      msg += `，${result.errors.length} 个源失败`;
    }
    sourcePullStatus.textContent = msg;
    sourcePullStatus.className = result.errors.length > 0 ? 'github-hint github-status-err' : 'github-hint github-status-ok';
    render();
  } catch (e) {
    sourcePullStatus.textContent = '✗ ' + e.message;
    sourcePullStatus.className = 'github-hint github-status-err';
  }

  sourcePullAll.disabled = false;
});

// 渲染订阅源列表
async function renderSources() {
  const sources = await BilibanStorage.getSources();
  sourceCount.textContent = sources.length;

  if (sources.length === 0) {
    sourceList.innerHTML = '<div class="source-empty">暂无订阅源</div>';
    return;
  }

  sourceList.innerHTML = sources.map(s => `
    <div class="source-item" data-source-id="${s.id}">
      <div class="source-info">
        <div class="source-name">${s.owner}/${s.repo}</div>
        <div class="source-path">${s.path} @ ${s.branch}</div>
      </div>
      ${s.chunks && s.chunks.length > 0 ? `
        <button class="source-chunks-toggle" data-source-id="${s.id}" title="查看块">▼</button>
      ` : ''}
      <button class="source-remove" data-source-id="${s.id}" title="移除">✕</button>
    </div>
    ${s.chunks && s.chunks.length > 0 ? `
      <div class="source-chunks" id="source-chunks-${s.id}">
        ${s.chunks.map(c => `
          <div class="source-chunk-item">
            <span class="source-chunk-name">${c.name}</span>
            <button class="source-chunk-pull" data-source-id="${s.id}" data-chunk-path="${c.path}">拉取</button>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `).join('');

  // 绑定事件
  sourceList.querySelectorAll('.source-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await BilibanStorage.removeSource(btn.dataset.sourceId);
      await renderSources();
    });
  });

  sourceList.querySelectorAll('.source-chunks-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const chunksEl = document.getElementById('source-chunks-' + btn.dataset.sourceId);
      if (chunksEl) {
        chunksEl.classList.toggle('expanded');
        btn.classList.toggle('expanded');
      }
    });
  });

  sourceList.querySelectorAll('.source-chunk-pull').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sourceId = btn.dataset.sourceId;
      const chunkPath = btn.dataset.chunkPath;
      const source = sources.find(s => s.id === sourceId);
      if (!source) return;

      btn.disabled = true;
      btn.textContent = '拉取中...';

      try {
        const data = await BilibanStorage.pullChunkFromSource(source, chunkPath);
        
        // 创建一个新块来存放拉取的数据
        const chunkName = chunkPath.replace('.json', '').split('/').pop();
        const chunks = await BilibanStorage.getChunks();
        let targetChunk = chunks.find(c => c.name === chunkName);
        
        if (!targetChunk) {
          targetChunk = await BilibanStorage.addChunk(chunkName, `来自 ${source.owner}/${source.repo}`);
        }

        await BilibanStorage.importChunkData(data, targetChunk.id, 'merge');
        
        showToast(`✅ 已从块「${chunkName}」拉取数据`);
        render();
        await renderChunks();
      } catch (e) {
        showToast('❌ 拉取失败: ' + e.message);
      }

      btn.disabled = false;
      btn.textContent = '拉取';
    });
  });
}

// ==================== 初始化 ====================

render();

// ==================== 强力屏蔽模式 ====================
async function initPowerMode() {
  const result = await chrome.storage.local.get('biliban_power_mode');
  const enabled = result.biliban_power_mode || false;
  updatePowerBtn(enabled);

  btnPower.addEventListener('click', async () => {
    const current = await chrome.storage.local.get('biliban_power_mode');
    const newVal = !current.biliban_power_mode;
    await chrome.storage.local.set({ biliban_power_mode: newVal });
    updatePowerBtn(newVal);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_POWER_MODE', enabled: newVal }).catch(() => {});
    }

    showToast(newVal ? '🛡️ 强力屏蔽已开启' : '🛡️ 强力屏蔽已关闭');
  });
}

function updatePowerBtn(enabled) {
  btnPower.style.background = enabled ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.2)';
  btnPower.title = enabled ? '强力屏蔽: 开启 (点击关闭)' : '强力屏蔽: 关闭 (点击开启)';
}

function showToast(msg) {
  let t = document.getElementById('biliban-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'biliban-toast';
    t.style.cssText = 'position:absolute;top:0;left:0;right:0;text-align:center;background:#333;color:#fff;padding:8px 0;font-size:13px;z-index:99999;transition:opacity 0.3s;pointer-events:none;border-radius:0 0 8px 8px;';
    const app = document.querySelector('.app') || document.body;
    app.style.position = 'relative';
    app.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(function() { t.style.opacity = '0'; }, 1500);
}

initPowerMode();
