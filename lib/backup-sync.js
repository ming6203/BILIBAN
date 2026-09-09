/**
 * BILIBAN Backup Sync (v1)
 * 「其他数据」备份/恢复：聚合表、事件数据、设置等（非黑名单数据）。
 * - 数据文件存仓库 data/ 目录（规范路径）
 * - 支持与黑名单同仓库，或独立数据仓库（高级设置可配）
 * - 复用 BilibanGithubSync 的 token/username/request 基础设施
 */

// 依赖：BilibanGithubSync（lib/github.js 先加载）

const BilibanBackupSync = {
  SETTINGS_KEY: 'biliban_backup_settings',
  DEFAULT_SETTINGS: {
    repoName: 'BILI-Blacklist',      // 黑名单仓库名（沿用）
    sameRepo: true,                  // 数据与黑名单同仓库
    dataRepoName: 'BILI-Blacklist-Data' // 独立数据仓库名
  },
  DATA_DIR: 'data',
  DATA_REPO_VIS_KEY: 'biliban_data_repo_visibility',

  // 数据文件规范：名称 -> storage 键读取函数
  DATA_FILES: [
    { name: 'stats',            key: 'biliban_block_events',     read: async () => (await chrome.storage.local.get('biliban_block_events')).biliban_block_events || null },
    { name: 'settings_scan',    key: 'biliban_scan_settings',    read: async () => (await chrome.storage.local.get('biliban_scan_settings')).biliban_scan_settings || null },
    { name: 'cache',            key: 'biliban_scan_cache',       read: async () => (await chrome.storage.local.get('biliban_scan_cache')).biliban_scan_cache || null },
    { name: 'settings_advanced',key: 'biliban_advanced_settings',read: async () => (await chrome.storage.local.get('biliban_advanced_settings')).biliban_advanced_settings || null },
    { name: 'settings_backup',  key: 'biliban_backup_settings',  read: async () => (await chrome.storage.local.get('biliban_backup_settings')).biliban_backup_settings || null }
  ],

  // ==================== 设置 ====================

  async getSettings() {
    try {
      const r = await chrome.storage.local.get(this.SETTINGS_KEY);
      return Object.assign({}, this.DEFAULT_SETTINGS, r[this.SETTINGS_KEY] || {});
    } catch (e) {
      return Object.assign({}, this.DEFAULT_SETTINGS);
    }
  },

  async setSettings(settings) {
    await chrome.storage.local.set({ [this.SETTINGS_KEY]: Object.assign({}, this.DEFAULT_SETTINGS, settings) });
  },

  // ==================== 仓库解析 ====================

  // 数据仓库全名：同仓库 -> 主仓库；独立 -> username/dataRepoName
  async getDataRepoFullName() {
    const s = await this.getSettings();
    if (s.sameRepo) return BilibanGithubSync.getRepoFullName();
    let username = await BilibanGithubSync.getUsername();
    if (!username) {
      const user = await BilibanGithubSync.request('/user');
      await BilibanGithubSync.setUsername(user.login);
      username = user.login;
    }
    return username + '/' + (s.dataRepoName || s.repoName);
  },

  // 数据仓库可见性偏好（独立数据仓库时使用；true=私有）
  async getDataRepoVisibilityPref() {
    const r = await chrome.storage.local.get(this.DATA_REPO_VIS_KEY);
    return r[this.DATA_REPO_VIS_KEY] !== false;
  },

  async setDataRepoVisibilityPref(isPrivate) {
    await chrome.storage.local.set({ [this.DATA_REPO_VIS_KEY]: isPrivate });
  },

  // 确保数据仓库存在（同仓库时复用主仓库 ensureRepo）
  async ensureDataRepo() {
    const s = await this.getSettings();
    if (s.sameRepo) return BilibanGithubSync.ensureRepo();
    const repoPath = await this.getDataRepoFullName();
    const isPrivate = await this.getDataRepoVisibilityPref();
    try {
      await BilibanGithubSync.request('/repos/' + repoPath);
      return repoPath;
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        await BilibanGithubSync.request('/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name: s.dataRepoName,
            description: 'BILIBAN - 使用数据备份',
            private: isPrivate,
            auto_init: true
          })
        });
        return repoPath;
      }
      throw e;
    }
  },

  // ==================== 文件读写 ====================

  // 写 data/<name>.json 到数据仓库
  async _putDataFile(name, payload, sha) {
    const repoPath = await this.ensureDataRepo();
    const filePath = this.DATA_DIR + '/' + name + '.json';
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    const body = {
      message: 'BILIBAN: 备份数据 (' + name + ')',
      content: content
    };
    if (sha) body.sha = sha;
    const result = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + filePath, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    return { url: result.content.html_url };
  },

  // 获取文件信息（含 sha），404 返回 exists:false
  async _getDataFileInfo(name) {
    const repoPath = await this.getDataRepoFullName();
    const filePath = this.DATA_DIR + '/' + name + '.json';
    try {
      const file = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + filePath);
      return { sha: file.sha, exists: true };
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        return { sha: null, exists: false };
      }
      throw e;
    }
  },

  // 列出 data/ 目录内容（[{ name, path, sha, size }]）
  async listDataFiles() {
    const repoPath = await this.getDataRepoFullName();
    let contents;
    try {
      contents = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + this.DATA_DIR);
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) return [];
      throw e;
    }
    if (!Array.isArray(contents)) return [];
    return contents
      .filter(c => c.type === 'file' && c.name.endsWith('.json'))
      .map(c => ({ name: c.name.replace(/\.json$/, ''), path: c.path, sha: c.sha, size: c.size }));
  },

  // 读取 data/<name>.json 内容（返回解析后的对象，404 返回 null）
  async readDataFile(name) {
    const repoPath = await this.getDataRepoFullName();
    const filePath = this.DATA_DIR + '/' + name + '.json';
    try {
      const file = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + filePath);
      const text = decodeURIComponent(escape(atob(file.content)));
      return JSON.parse(text);
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) return null;
      throw e;
    }
  },

  // ==================== 推送全部数据 ====================

  // 打包本地所有数据
  async collectAllData() {
    const out = {};
    for (const df of this.DATA_FILES) {
      try {
        out[df.name] = await df.read();
      } catch (e) {
        out[df.name] = null;
      }
    }
    return out;
  },

  // 推送全部数据到 data/ 目录；返回 [{name, ok, message}]
  async pushAllData() {
    const data = await this.collectAllData();
    const results = [];
    for (const df of this.DATA_FILES) {
      const payload = data[df.name];
      if (payload == null) { results.push({ name: df.name, ok: false, message: '无本地数据，跳过' }); continue; }
      try {
        const info = await this._getDataFileInfo(df.name);
        const r = await this._putDataFile(df.name, payload, info.sha);
        results.push({ name: df.name, ok: true, message: info.exists ? '已更新' : '已创建', url: r.url });
      } catch (e) {
        results.push({ name: df.name, ok: false, message: e.message || '失败' });
      }
    }
    return results;
  },

  // ==================== 恢复 ====================

  // 恢复全部 data/ 文件到本地 storage；mode: 'overwrite' | 'merge'
  // 返回 { restored: [{name, ok, message}], errors }
  async restoreAllData(mode) {
    const files = await this.listDataFiles();
    const results = [];
    let errors = 0;
    for (const f of files) {
      const df = this.DATA_FILES.find(d => d.name === f.name);
      if (!df) { results.push({ name: f.name, ok: false, message: '未知文件，跳过' }); continue; }
      try {
        const payload = await this.readDataFile(f.name);
        if (payload == null) { results.push({ name: f.name, ok: false, message: '读取失败' }); errors++; continue; }
        if (mode === 'merge' && df.name === 'stats') {
          // 合并模式：聚合事件按键合并
          await this._mergeStats(payload);
        } else {
          await chrome.storage.local.set({ [df.key]: payload });
        }
        results.push({ name: f.name, ok: true, message: '已恢复' });
      } catch (e) {
        results.push({ name: f.name, ok: false, message: e.message || '失败' });
        errors++;
      }
    }
    return { restored: results, errors: errors };
  },

  // 合并恢复统计事件（events 去重合并 + buckets 累加）
  async _mergeStats(remote) {
    const local = (await chrome.storage.local.get('biliban_block_events')).biliban_block_events || { events: [], buckets: {}, aggregates: {} };
    const seen = new Set(local.events.map(e => e.id));
    for (const e of (remote.events || [])) {
      if (!seen.has(e.id)) { local.events.push(e); seen.add(e.id); }
    }
    // buckets 累加
    for (const k of Object.keys(remote.buckets || {})) {
      local.buckets = local.buckets || {};
      local.buckets[k] = (local.buckets[k] || 0) + (remote.buckets[k] || 0);
    }
    for (const k of Object.keys(remote.videoBuckets || {})) {
      local.videoBuckets = local.videoBuckets || {};
      local.videoBuckets[k] = (local.videoBuckets[k] || 0) + (remote.videoBuckets[k] || 0);
    }
    for (const k of Object.keys(remote.commentBuckets || {})) {
      local.commentBuckets = local.commentBuckets || {};
      local.commentBuckets[k] = (local.commentBuckets[k] || 0) + (remote.commentBuckets[k] || 0);
    }
    await chrome.storage.local.set({ 'biliban_block_events': local });
  },

  // 按仓库链接解析 owner/repo（支持 owner/repo 或完整 URL）
  parseRepoRef(input) {
    const s = (input || '').trim();
    if (!s) return null;
    // 完整 URL: https://github.com/owner/repo 或带 /tree/... 
    const m = s.match(/github\.com\/([^\/]+)\/([^\/#?]+)/);
    if (m) return m[1] + '/' + m[2];
    // owner/repo 格式
    const m2 = s.match(/^([^\/\s]+)\/([^\/\s]+)$/);
    if (m2) return m2[1] + '/' + m2[2];
    return null;
  },

  // ==================== 任意仓库浏览/恢复（按 owner/repo） ====================

  // 列出指定仓库的 data/ 目录（用于云端恢复的仓库链接浏览）
  async listDataFilesFromRepo(repoRef) {
    try {
      const contents = await BilibanGithubSync.request('/repos/' + repoRef + '/contents/' + this.DATA_DIR);
      if (!Array.isArray(contents)) return [];
      return contents
        .filter(c => c.type === 'file' && c.name.endsWith('.json'))
        .map(c => ({ name: c.name.replace(/\.json$/, ''), path: c.path, sha: c.sha, size: c.size }));
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) return [];
      throw e;
    }
  },

  // 读取指定仓库的 data/<name>.json（用于云端恢复）
  async readDataFileFromRepo(name, repoRef) {
    const filePath = this.DATA_DIR + '/' + name + '.json';
    try {
      const file = await BilibanGithubSync.request('/repos/' + repoRef + '/contents/' + filePath);
      const text = decodeURIComponent(escape(atob(file.content)));
      return JSON.parse(text);
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) return null;
      throw e;
    }
  }
};
