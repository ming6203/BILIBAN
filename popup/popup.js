/**
 * BILIBAN Popup（轻量版）
 * 仅保留：云同步（GitHub 备份/恢复、分块推送拉取）、社区订阅（拉取合并）、
 * 本地导入导出，以及完整管理面板入口。
 * 分组/分块管理、评论扫描等重逻辑功能已迁移至管理页（options page）。
 */

// ==================== DOM 元素 ====================
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const fileImport = document.getElementById('file-import');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

// GitHub 相关
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

// 仓库可见性
const visPrivate = document.getElementById('vis-private');
const visPublic = document.getElementById('vis-public');
const visibilityStatus = document.getElementById('visibility-status');

// 分块相关
const chunkList = document.getElementById('chunk-list');
const btnPushSelected = document.getElementById('btn-push-selected');
const btnPullSelected = document.getElementById('btn-pull-selected');
const chunkSyncStatus = document.getElementById('chunk-sync-status');

// 订阅相关
const sourceInput = document.getElementById('source-input');
const sourceAdd = document.getElementById('source-add');
const sourceAddStatus = document.getElementById('source-add-status');
const sourcePullAll = document.getElementById('source-pull-all');
const sourcePullStatus = document.getElementById('source-pull-status');
const sourceCount = document.getElementById('source-count');
const sourceList = document.getElementById('source-list');

// 完整管理面板入口
const btnManage = document.getElementById('btn-manage');

// ==================== 分块选择状态 ====================
let selectedChunkIds = new Set();

// ==================== 工具函数 ====================

function showModal(title, bodyHTML, onConfirm) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHTML;
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

// ==================== 完整管理面板入口 ====================

btnManage.addEventListener('click', () => {
  chrome.runtime.openOptionsPage().catch(() => {
    // 兜底：直接打开管理页标签
    chrome.tabs.create({ url: chrome.runtime.getURL('manage/manage.html') });
  });
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
  } catch { showModal('导入失败', '<p>文件格式无效，请选择 BILIBAN 导出的 JSON 备份</p>', () => {}); fileImport.value = ''; return; }

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
  if (result !== null) { showToast('✅ 导入完成'); }
});

// ==================== GitHub 面板 ====================

// 弹窗即云同步界面：打开时自动加载已保存的 Token 与订阅源
async function initGithubPanel() {
  const token = await BilibanGithubSync.getToken();
  if (token) {
    githubTokenInput.value = token;
    await checkGithubToken();
  }
  await renderSources();
}

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

    // 初始化仓库可见性状态
    await initVisibilityUI();

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

// 仓库可见性切换
async function initVisibilityUI() {
  const isPrivate = await BilibanGithubSync.getRepoVisibilityPref();
  updateVisibilityButtons(isPrivate);
}

function updateVisibilityButtons(isPrivate) {
  visPrivate.classList.toggle('active', isPrivate);
  visPublic.classList.toggle('active', !isPrivate);
  visPrivate.disabled = isPrivate;
  visPublic.disabled = !isPrivate;
}

async function applyVisibility(isPrivate) {
  await BilibanGithubSync.setRepoVisibilityPref(isPrivate);
  updateVisibilityButtons(isPrivate);

  const label = isPrivate ? '私有' : '公共';
  visibilityStatus.textContent = '正在切换仓库为' + label + '...';
  visibilityStatus.className = 'github-hint github-status-loading';

  try {
    const result = await BilibanGithubSync.syncRepoVisibility();
    if (result.created === false) {
      visibilityStatus.textContent = '✓ 偏好已保存：推送时将创建' + label + '仓库';
      visibilityStatus.className = 'github-hint github-status-ok';
    } else {
      visibilityStatus.textContent = '✓ 仓库已切换为' + label +
        (result.changed ? '' : '（本来就是' + label + '）');
      visibilityStatus.className = 'github-hint github-status-ok';
    }
  } catch (e) {
    visibilityStatus.textContent = '✗ 切换失败: ' + e.message + '（将在下次推送时重试）';
    visibilityStatus.className = 'github-hint github-status-err';
  }
}

visPrivate.addEventListener('click', () => applyVisibility(true));
visPublic.addEventListener('click', () => applyVisibility(false));

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
      } catch (e) {
        githubSyncStatus.textContent = '✗ ' + e.message;
        githubSyncStatus.className = 'github-hint github-status-err';
      }
      githubPull.disabled = false;
    });
});

// ==================== 分块同步（只读列表 + 推送/拉取） ====================

async function renderChunks() {
  const chunks = await BilibanStorage.getChunks();
  const groups = await BilibanStorage.getGroups();

  if (chunks.length === 0) {
    chunkList.innerHTML = '<div class="chunk-empty">暂无分块，可在完整管理面板创建</div>';
    updateChunkButtons();
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
      </div>`;
  }).join('');

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

  updateChunkButtons();
}

function updateChunkButtons() {
  const hasSelection = selectedChunkIds.size > 0;
  btnPushSelected.disabled = !hasSelection;
  btnPullSelected.disabled = !hasSelection;
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

      const chunkData = await BilibanStorage.getChunkData(chunk.id);
      const result = await BilibanGithubSync.pushChunk(chunk, chunkData);
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
    <p style="margin-top:12px">🔄 块身份（ID）与名称以云端备份为准对齐，云端重命名会同步到本地</p>
    <p style="margin-top:12px;color:#ff4d4f">⚠️ 这将替换本地这些块下的所有分组数据</p>
  `, async () => {
    btnPullSelected.disabled = true;
    chunkSyncStatus.textContent = '拉取中...';
    chunkSyncStatus.className = 'github-hint github-status-loading';

    try {
      const results = [];
      const failures = [];

      for (const chunk of selectedChunks) {
        try {
          const pullResult = await BilibanGithubSync.pullChunk(chunk);

          if (pullResult.chunkId && pullResult.chunkId !== chunk.id) {
            const adopted = await BilibanStorage.adoptChunkId(chunk.id, pullResult.chunkId);
            if (adopted) chunk.id = pullResult.chunkId;
          }

          if (pullResult.chunkName && pullResult.chunkName !== chunk.name) {
            await BilibanStorage.renameChunk(chunk.id, pullResult.chunkName);
            chunk.name = pullResult.chunkName;
          }

          await BilibanStorage.importChunkData(pullResult.data, chunk.id, 'replace');
          results.push(chunk.name);
        } catch (e) {
          console.error(`拉取块 ${chunk.name} 失败:`, e);
          failures.push(chunk.name);
        }
      }

      if (results.length > 0) {
        let msg = `✓ 已拉取 ${results.length} 个块`;
        if (failures.length > 0) msg += `，${failures.length} 个失败`;
        chunkSyncStatus.textContent = msg;
        chunkSyncStatus.className = failures.length > 0 ? 'github-hint github-status-err' : 'github-hint github-status-ok';
        showToast(`✅ 已拉取 ${results.length} 个块`);
      } else {
        chunkSyncStatus.textContent = '✗ 拉取失败：云端未找到所选块';
        chunkSyncStatus.className = 'github-hint github-status-err';
      }
      await renderChunks();
    } catch (e) {
      chunkSyncStatus.textContent = '✗ ' + e.message;
      chunkSyncStatus.className = 'github-hint github-status-err';
    }

    btnPullSelected.disabled = false;
  });
});

// ==================== 订阅源管理 ====================

function parseSourceInput(input) {
  input = input.trim();
  let m = input.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3], path: m[4] };

  m = input.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (m) return { owner: m[1], repo: m[2], branch: 'main', path: 'blacklist.json' };

  m = input.match(/^([^/]+)\/([^/]+)\/(.+\\.json)$/);
  if (m) return { owner: m[1], repo: m[2], branch: 'main', path: m[3] };

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
    const url = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${parsed.path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('文件不存在或仓库不可访问 (' + resp.status + ')');

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

        const chunkName = chunkPath.replace('.json', '').split('/').pop();
        const chunks = await BilibanStorage.getChunks();
        let targetChunk = chunks.find(c => c.name === chunkName);

        if (!targetChunk) {
          targetChunk = await BilibanStorage.addChunk(chunkName, `来自 ${source.owner}/${source.repo}`);
        }

        await BilibanStorage.importChunkData(data, targetChunk.id, 'merge');

        showToast(`✅ 已从块「${chunkName}」拉取数据`);
        if (githubSyncSection.style.display !== 'none') await renderChunks();
      } catch (e) {
        showToast('❌ 拉取失败: ' + e.message);
      }

      btn.disabled = false;
      btn.textContent = '拉取';
    });
  });
}

// ==================== 初始化 ====================

initGithubPanel();