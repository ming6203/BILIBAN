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
  BACKUP_DIR: 'data/backup',
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

  // 写 data/backup/<name>.json 到数据仓库
  async _putDataFile(name, payload, sha) {
    const repoPath = await this.ensureDataRepo();
    const filePath = this.BACKUP_DIR + '/' + name + '.json';
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
    const filePath = this.BACKUP_DIR + '/' + name + '.json';
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

  // 列出备份文件（data/backup/ + 旧 data/ 根目录兼容，跳过 archive/），[{ name, path, sha, size }]
  async listDataFiles() {
    const repoPath = await this.getDataRepoFullName();
    const map = {};
    for (const dir of [this.BACKUP_DIR, this.DATA_DIR]) {
      let contents;
      try {
        contents = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + dir);
      } catch (e) {
        if (e.message.includes('404') || e.message.includes('Not Found')) continue;
        throw e;
      }
      if (!Array.isArray(contents)) continue;
      for (const c of contents) {
        if (c.type !== 'file' || !c.name.endsWith('.json')) continue;
        const name = c.name.replace(/\.json$/, '');
        if (!map[name]) map[name] = { name: name, path: c.path, sha: c.sha, size: c.size };
      }
    }
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  },

  // 读取备份文件内容（新路径 data/backup/ 优先，旧路径 data/ 兜底；404 返回 null）
  async readDataFile(name) {
    const repoPath = await this.getDataRepoFullName();
    for (const dir of [this.BACKUP_DIR, this.DATA_DIR]) {
      const filePath = dir + '/' + name + '.json';
      try {
        const file = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + filePath);
        const text = decodeURIComponent(escape(atob(file.content)));
        return JSON.parse(text);
      } catch (e) {
        if (e.message.includes('404') || e.message.includes('Not Found')) continue;
        throw e;
      }
    }
    return null;
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

  // 列出指定仓库的备份文件（data/backup/ + 旧 data/ 根目录兼容，跳过 archive/）
  async listDataFilesFromRepo(repoRef) {
    const map = {};
    for (const dir of [this.BACKUP_DIR, this.DATA_DIR]) {
      let contents;
      try {
        contents = await BilibanGithubSync.request('/repos/' + repoRef + '/contents/' + dir);
      } catch (e) {
        if (e.message.includes('404') || e.message.includes('Not Found')) continue;
        throw e;
      }
      if (!Array.isArray(contents)) continue;
      for (const c of contents) {
        if (c.type !== 'file' || !c.name.endsWith('.json')) continue;
        const name = c.name.replace(/\.json$/, '');
        if (!map[name]) map[name] = { name: name, path: c.path, sha: c.sha, size: c.size };
      }
    }
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  },

  // 读取指定仓库的备份文件（新路径优先，旧路径兜底）
  async readDataFileFromRepo(name, repoRef) {
    for (const dir of [this.BACKUP_DIR, this.DATA_DIR]) {
      const filePath = dir + '/' + name + '.json';
      try {
        const file = await BilibanGithubSync.request('/repos/' + repoRef + '/contents/' + filePath);
        const text = decodeURIComponent(escape(atob(file.content)));
        return JSON.parse(text);
      } catch (e) {
        if (e.message.includes('404') || e.message.includes('Not Found')) continue;
        throw e;
      }
    }
    return null;
  },

  // ==================== 归档（Archive） ====================

  ARCHIVE_DIR: 'data/archive',
  CURSOR_KEY: 'biliban_archive_cursor',
  DOWNLOADS_KEY: 'biliban_archive_downloads',

  // 读归档游标（归档边界：cursor 之前 = 已归档）
  async getArchiveCursor() {
    try {
      const r = await chrome.storage.local.get(this.CURSOR_KEY);
      return r[this.CURSOR_KEY] || null;
    } catch (e) { return null; }
  },

  async setArchiveCursor(cursor) {
    await chrome.storage.local.set({ [this.CURSOR_KEY]: cursor });
  },

  // 读本地事件数据（biliban_block_events）
  async _readLocalStats() {
    try {
      const r = await chrome.storage.local.get('biliban_block_events');
      return r.biliban_block_events || { events: [], aggregates: {}, buckets: {} };
    } catch (e) { return { events: [], aggregates: {}, buckets: {} }; }
  },

  // 读高级设置中的归档阈值（MB），默认 5
  async _archiveMergeMB() {
    try {
      const r = await chrome.storage.local.get('biliban_advanced_settings');
      const s = r.biliban_advanced_settings || {};
      const v = Number(s.archiveMergeMB);
      return (v > 0) ? v : 5;
    } catch (e) { return 5; }
  },

  // 列出云端归档分块（data/archive/part_*.json，含 meta 摘要）
  async listArchiveParts() {
    const repoPath = await this.getDataRepoFullName();
    let contents;
    try {
      contents = await BilibanGithubSync.request('/repos/' + repoPath + '/contents/' + this.ARCHIVE_DIR);
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) return [];
      throw e;
    }
    if (!Array.isArray(contents)) return [];
    const result = [];
    for (const c of contents) {
      if (c.type !== 'file' || !/^part_\d+\.json$/.test(c.name)) continue;
      const name = c.name.replace(/\.json$/, '');
      try {
        const part = await this.readDataFile('archive/' + name);
        result.push({ name: name, meta: part && part.meta ? part.meta : null, size: c.size });
      } catch (e) { /* 单个分块损坏不影响列表 */ }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  },

  // 归档未归档数据：合并/裂分/快照/上传/幂等。返回 { archived, parts, message }
  async archivePendingData() {
    const thresholdBytes = (await this._archiveMergeMB()) * 1024 * 1024;
    const data = await this._readLocalStats();
    const events = data.events || [];
    const aggregates = data.aggregates || {};
    const cursor = await this.getArchiveCursor();
    const cursorTs = cursor ? cursor.lastTimestamp : 0;

    // 未归档 = timestamp > cursor（首次无 cursor = 全部）
    const pending = events
      .filter(ev => (ev.timestamp || 0) > cursorTs)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (pending.length === 0) return { archived: 0, parts: [], message: '无未归档数据' };

    // 聚合表全量快照（归档即快照）
    const aggSnapshot = Object.keys(aggregates).length ? JSON.parse(JSON.stringify(aggregates)) : {};
    const parts = await this.listArchiveParts();
    const active = parts.length ? parts[parts.length - 1] : null;

    // 组装分块：先尝试填满活跃分块（< 阈值才合并），剩余按阈值裂分
    const chunks = [];       // [{ id, events, aggregates }]
    let queue = pending.slice();

    if (active && active.meta && active.meta.sizeBytes < thresholdBytes) {
      const activeData = await this.readDataFile('archive/' + active.name);
      if (activeData && Array.isArray(activeData.events)) {
        const mergedEvents = activeData.events.slice();
        const aggMerged = Object.assign({}, activeData.aggregates || {}, aggSnapshot);
        while (queue.length > 0) {
          const ev = queue[0];
          const est = JSON.stringify({ events: mergedEvents.concat(ev), aggregates: aggMerged }).length;
          if (est > thresholdBytes) break;
          mergedEvents.push(ev);
          queue.shift();
        }
        if (mergedEvents.length > activeData.events.length) {
          chunks.push({ id: active.name, events: mergedEvents, aggregates: aggMerged });
        }
      }
    }

    let nextNum = parts.length + 1;
    while (queue.length > 0) {
      const chunkEvents = [];
      while (queue.length > 0) {
        const ev = queue[0];
        const est = JSON.stringify({ events: chunkEvents.concat(ev), aggregates: aggSnapshot }).length;
        if (chunkEvents.length > 0 && est > thresholdBytes) break;
        chunkEvents.push(ev);
        queue.shift();
      }
      if (chunkEvents.length > 0) {
        chunks.push({ id: 'part_' + String(nextNum).padStart(3, '0'), events: chunkEvents, aggregates: aggSnapshot });
        nextNum++;
      }
    }

    if (chunks.length === 0) return { archived: 0, parts: [], message: '数据量过小，未形成分块' };

    // 组装 meta + 逐个上传（PUT 覆盖幂等）
    const uploaded = [];
    for (const chunk of chunks) {
      const ts = chunk.events.map(e => e.timestamp || 0);
      const meta = {
        id: chunk.id,
        version: 2,
        createdAt: (active && chunk.id === active.name && active.meta && active.meta.createdAt) ? active.meta.createdAt : Date.now(),
        lastMergedAt: Date.now(),
        timeRange: { from: Math.min.apply(null, ts), to: Math.max.apply(null, ts) },
        eventCount: chunk.events.length,
        videoCount: chunk.events.filter(e => e.type === 'video').length,
        commentCount: chunk.events.filter(e => e.type !== 'video').length,
        aggCount: Object.keys(chunk.aggregates).length,
        sizeBytes: JSON.stringify({ meta: {}, events: chunk.events, aggregates: chunk.aggregates }).length
      };
      const payload = { meta: meta, events: chunk.events, aggregates: chunk.aggregates };
      const name = 'archive/' + chunk.id;
      const info = await this._getDataFileInfo(name);
      await this._putDataFile(name, payload, info.sha);
      uploaded.push({ id: chunk.id, eventCount: chunk.events.length });
    }

    // 全部上传成功 → 更新 cursor + 本地聚合表清空（快照已入分块）
    const lastEv = pending[pending.length - 1];
    await this.setArchiveCursor({
      lastEventId: lastEv.id || '',
      lastTimestamp: lastEv.timestamp || Date.now(),
      updatedAt: Date.now()
    });
    if (Object.keys(aggSnapshot).length) {
      data.aggregates = {};
      data.meta = data.meta || {};
      data.meta.lastArchivedAt = Date.now();
      await chrome.storage.local.set({ biliban_block_events: data });
    }

    return { archived: pending.length, parts: uploaded, message: '归档完成：新增 ' + pending.length + ' 事件' };
  },

  // 自动清理（保留策略，跟随限制模式）；归档上传成功后调用
  async autoCleanArchived() {
    try {
      const r = await chrome.storage.local.get('biliban_advanced_settings');
      const s = r.biliban_advanced_settings || {};
      if (!s.archiveAutoClean) return { cleaned: 0, message: '自动清理未开启' };
      const mode = s.eventLimitMode || 'size';
      const data = await this._readLocalStats();
      let events = data.events || [];
      if (events.length === 0) return { cleaned: 0, message: '无数据' };

      if (mode === 'size') {
        const limitMB = Number(s.maxEventsMB);
        if (!(limitMB > 0)) return { cleaned: 0, message: '大小上限 0 = 不限制' };
        const limitBytes = limitMB * 1024 * 1024;
        const est = () => JSON.stringify(events).length * 2;
        if (est() <= limitBytes) return { cleaned: 0, message: '未达大小阈值，不清理' };
        // 从尾部累计保留字节，头部删除
        let keepStart = events.length;
        let bytes = 0;
        while (keepStart > 0) {
          const estOne = JSON.stringify(events[keepStart - 1]).length * 2;
          if (bytes + estOne > limitBytes) break;
          bytes += estOne;
          keepStart--;
        }
        const cleaned = keepStart; // 删除最旧 keepStart 条（保留 [keepStart, end)）
        if (cleaned <= 0) return { cleaned: 0, message: '未达大小阈值，不清理' };
        data.events = events.slice(keepStart);
        await chrome.storage.local.set({ biliban_block_events: data });
        return { cleaned: cleaned, message: '自动清理 ' + cleaned + ' 条旧数据（大小保留）' };
      }

      // 数量模式
      const limit = Number(s.maxEvents);
      if (!(limit > 0)) return { cleaned: 0, message: '数量上限 0 = 不限制' };
      if (events.length <= limit) return { cleaned: 0, message: '未达数量阈值，不清理' };
      const cleaned = events.length - limit;
      data.events = events.slice(events.length - limit);
      await chrome.storage.local.set({ biliban_block_events: data });
      return { cleaned: cleaned, message: '自动清理 ' + cleaned + ' 条旧数据（数量保留）' };
    } catch (e) {
      return { cleaned: 0, error: e.message || '清理失败' };
    }
  },

  // 手动清理已归档数据（按百分比删最旧；0=不删 100=全清）
  async manualCleanArchived(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 50));
    const cursor = await this.getArchiveCursor();
    if (!cursor) return { cleaned: 0, message: '尚无归档记录' };
    const cursorTs = cursor.lastTimestamp || 0;
    const data = await this._readLocalStats();
    const events = data.events || [];
    // 已归档 = timestamp <= cursorTs（按时间升序排列，头部最旧）
    const archived = events.filter(ev => (ev.timestamp || 0) <= cursorTs);
    if (archived.length === 0) return { cleaned: 0, message: '无已归档数据可清理' };
    const toRemove = Math.floor(archived.length * p / 100);
    if (toRemove <= 0) return { cleaned: 0, message: '清理比例过小' };
    // 按时间排序后删除最旧 toRemove 条（时间升序，头部最旧）
    const sorted = archived.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const removeSet = new Set(sorted.slice(0, toRemove).map(e => e.id || (e.timestamp + '_' + e.uid)));
    const kept = events.filter(ev => !removeSet.has(ev.id || (ev.timestamp + '_' + ev.uid)));
    data.events = kept;
    await chrome.storage.local.set({ biliban_block_events: data });
    return { cleaned: toRemove, remaining: kept.length, message: '手动清理 ' + toRemove + ' 条已归档旧数据' };
  },

  // 读/写下载记录
  async getDownloads() {
    try {
      const r = await chrome.storage.local.get(this.DOWNLOADS_KEY);
      return r[this.DOWNLOADS_KEY] || [];
    } catch (e) { return []; }
  },

  async addDownload(record) {
    const list = await this.getDownloads();
    list.push(record);
    await chrome.storage.local.set({ [this.DOWNLOADS_KEY]: list });
    return list;
  },

  async removeDownload(id) {
    const list = await this.getDownloads();
    const kept = list.filter(d => d.id !== id);
    await chrome.storage.local.set({ [this.DOWNLOADS_KEY]: kept });
    return kept;
  }
};
