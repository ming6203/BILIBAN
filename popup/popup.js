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

// 订阅相关
const sourceInput = document.getElementById('source-input');
const sourceAdd = document.getElementById('source-add');
const sourceAddStatus = document.getElementById('source-add-status');
const sourcePullAll = document.getElementById('source-pull-all');
const sourcePullStatus = document.getElementById('source-pull-status');
const sourceCount = document.getElementById('source-count');
const sourceList = document.getElementById('source-list');

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

// ==================== 渲染 ====================

async function render() {
  const expandedIds = new Set();
  document.querySelectorAll('.group-card.expanded').forEach(c => expandedIds.add(c.dataset.groupId));

  const groups = await BilibanStorage.getGroups();

  selectGroup.innerHTML = groups.length === 0
    ? '<option value="">请先创建分组</option>'
    : groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');

  groupsContainer.innerHTML = '';

  if (groups.length === 0) {
    groupsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">还没有屏蔽分组<br>点击下方按钮创建第一个分组</div>
      </div>`;
  } else {
    for (const group of groups) {
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

      card.innerHTML = `
        <div class="group-header">
          <div class="group-toggle ${group.enabled ? 'active' : ''}" data-group-id="${group.id}"></div>
          <div class="group-name" data-group-id="${group.id}">${group.name}</div>
          <div class="group-count">${group.uids.length} 人</div>
          <div class="group-expand">▼</div>
          <div class="group-actions">
            <button class="group-action-btn" data-action="rename" data-group-id="${group.id}" title="重命名">✏️</button>
            <button class="group-action-btn" data-action="delete" data-group-id="${group.id}" title="删除分组">🗑️</button>
          </div>
        </div>
        <div class="group-body">
          <div class="uid-list">${uidTags}</div>
        </div>`;

      groupsContainer.appendChild(card);
      if (expandedIds.has(group.id)) card.classList.add('expanded');
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
      if (e.target.closest('.group-toggle') || e.target.closest('.group-action-btn')) return;
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
    });
  });
}

// ==================== 添加用户 ====================

btnAdd.addEventListener('click', async () => {
  const uid = parseInt(inputUid.value.trim(), 10);
  const groupId = selectGroup.value;
  if (!uid || isNaN(uid) || uid <= 0) { showError('请输入有效的 UID（纯数字）'); return; }
  if (!groupId) { showError('请先选择或创建一个分组'); return; }
  const added = await BilibanStorage.addUidToGroup(groupId, uid);
  if (added) { inputUid.value = ''; render(); }
  else { showError('该用户已在此分组中'); }
});
inputUid.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnAdd.click(); });

// ==================== 新建分组 ====================

btnAddGroup.addEventListener('click', async () => {
  const result = await showModal('新建分组',
    '<p>输入分组名称：</p><input type="text" id="new-group-name" placeholder="如：杠精、广告号...">',
    async () => {
      const input = document.getElementById('new-group-name');
      if (input.value.trim()) await BilibanStorage.addGroup(input.value.trim());
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
    const status = await BilibanGithubSync.getSyncStatus();
    if (status.synced) {
      githubSyncStatus.textContent = '上次同步: ' + new Date(status.updatedAt).toLocaleString();
      githubSyncStatus.className = 'github-hint github-status-ok';
      githubLink.style.display = 'block'; githubLinkUrl.href = status.url;
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

// 推送
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

// 拉取
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
      <button class="source-remove" data-source-id="${s.id}" title="移除">✕</button>
    </div>
  `).join('');

  sourceList.querySelectorAll('.source-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await BilibanStorage.removeSource(btn.dataset.sourceId);
      await renderSources();
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

