/**
 * BILIBAN Storage Layer
 * Data structure:
 * {
 *   groups: [{ id, name, enabled, uids: number[], chunkId?: string }],
 *   chunks: [{ id, name, description }],
 *   sources: [{ id, owner, repo, path, branch, name, chunks: [{name, path}] }]
 * }
 */

const BilibanStorage = {

  STORAGE_KEY: 'biliban_blacklist',
  CHUNKS_KEY: 'biliban_chunks',
  SOURCES_KEY: 'biliban_sources',

  // ==================== 基础读写 ====================

  async _load() {
    const result = await chrome.storage.local.get(this.STORAGE_KEY);
    return result[this.STORAGE_KEY] || { groups: [] };
  },

  async _save(data) {
    await chrome.storage.local.set({ [this.STORAGE_KEY]: data });
  },

  // ==================== 分块管理 ====================

  async getChunks() {
    const result = await chrome.storage.local.get(this.CHUNKS_KEY);
    return result[this.CHUNKS_KEY] || [];
  },

  async saveChunks(chunks) {
    await chrome.storage.local.set({ [this.CHUNKS_KEY]: chunks });
  },

  async addChunk(name, description = '') {
    const chunks = await this.getChunks();
    const chunk = {
      id: 'chk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: name,
      description: description
    };
    chunks.push(chunk);
    await this.saveChunks(chunks);
    return chunk;
  },

  async removeChunk(chunkId) {
    const chunks = await this.getChunks();
    const filtered = chunks.filter(c => c.id !== chunkId);
    await this.saveChunks(filtered);

    // 将分组从该块中移除（但不删除分组）
    const data = await this._load();
    for (const group of data.groups) {
      if (group.chunkId === chunkId) {
        delete group.chunkId;
      }
    }
    await this._save(data);
  },

  async renameChunk(chunkId, newName) {
    const chunks = await this.getChunks();
    const chunk = chunks.find(c => c.id === chunkId);
    if (chunk) {
      chunk.name = newName;
      await this.saveChunks(chunks);
    }
  },

  async moveGroupToChunk(groupId, chunkId) {
    const data = await this._load();
    const group = data.groups.find(g => g.id === groupId);
    if (group) {
      if (chunkId) {
        group.chunkId = chunkId;
      } else {
        delete group.chunkId;
      }
      await this._save(data);
    }
  },

  async getGroupsByChunk(chunkId) {
    const data = await this._load();
    if (!chunkId) {
      // 返回未分配到任何块的分组
      return data.groups.filter(g => !g.chunkId);
    }
    return data.groups.filter(g => g.chunkId === chunkId);
  },

  async getChunkData(chunkId) {
    const groups = await this.getGroupsByChunk(chunkId);
    return { groups };
  },

  async importChunkData(chunkData, chunkId, mode = 'merge') {
    if (!chunkData.groups || !Array.isArray(chunkData.groups)) {
      throw new Error('无效的块数据格式');
    }

    const data = await this._load();

    if (mode === 'replace') {
      // 删除该块下的所有分组
      data.groups = data.groups.filter(g => g.chunkId !== chunkId);
      // 导入新分组
      for (const impGroup of chunkData.groups) {
        data.groups.push({
          id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: impGroup.name,
          enabled: impGroup.enabled !== false,
          uids: impGroup.uids || [],
          chunkId: chunkId
        });
      }
    } else {
      // 合并模式
      for (const impGroup of chunkData.groups) {
        let existing = data.groups.find(g => g.name === impGroup.name && g.chunkId === chunkId);
        if (!existing) {
          existing = {
            id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            name: impGroup.name,
            enabled: impGroup.enabled !== false,
            uids: [],
            chunkId: chunkId
          };
          data.groups.push(existing);
        }
        for (const uid of (impGroup.uids || [])) {
          const uidNum = Number(uid);
          if (!isNaN(uidNum) && !existing.uids.includes(uidNum)) {
            existing.uids.push(uidNum);
          }
        }
      }
    }

    await this._save(data);
  },

  // ==================== 分组操作 ====================

  async getGroups() {
    const data = await this._load();
    return data.groups;
  },

  async addGroup(name, chunkId = null) {
    const data = await this._load();
    const group = {
      id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: name,
      enabled: true,
      uids: []
    };
    if (chunkId) {
      group.chunkId = chunkId;
    }
    data.groups.push(group);
    await this._save(data);
    return group;
  },

  async removeGroup(groupId) {
    const data = await this._load();
    data.groups = data.groups.filter(g => g.id !== groupId);
    await this._save(data);
  },

  async renameGroup(groupId, newName) {
    const data = await this._load();
    const group = data.groups.find(g => g.id === groupId);
    if (group) {
      group.name = newName;
      await this._save(data);
    }
  },

  async toggleGroup(groupId) {
    const data = await this._load();
    const group = data.groups.find(g => g.id === groupId);
    if (group) {
      group.enabled = !group.enabled;
      await this._save(data);
    }
  },

  /**
   * 重新排列分组顺序
   * @param {string[]} orderedIds - 按新顺序排列的分组 ID 数组
   */
  async reorderGroups(orderedIds) {
    const data = await this._load();
    const groupMap = new Map(data.groups.map(g => [g.id, g]));
    const reordered = [];
    for (const id of orderedIds) {
      if (groupMap.has(id)) {
        reordered.push(groupMap.get(id));
      }
    }
    // 添加任何未在 orderedIds 中但存在的分组（以防遗漏）
    for (const group of data.groups) {
      if (!orderedIds.includes(group.id)) {
        reordered.push(group);
      }
    }
    data.groups = reordered;
    await this._save(data);
  },

  // ==================== UID 操作 ====================

  async addUidToGroup(groupId, uid) {
    const uidNum = Number(uid);
    if (isNaN(uidNum) || uidNum <= 0) {
      return { ok: false, reason: 'invalid_uid' };
    }
    const data = await this._load();
    const group = data.groups.find(g => g.id === groupId);
    if (!group) {
      return { ok: false, reason: 'group_not_found' };
    }
    if (group.uids.includes(uidNum)) {
      return { ok: false, reason: 'duplicate', groupName: group.name };
    }
    group.uids.push(uidNum);
    await this._save(data);
    return { ok: true, groupName: group.name };
  },

  /**
   * 清理所有分组内的重复 UID，并将所有 UID 规范化为 Number 类型
   * 每个分组内的 UID 应唯一，不同分组间可重复
   * @returns {Promise<{cleaned: number, details: Array<{group, removed}>}>}
   */
  async deduplicateAllGroups() {
    const data = await this._load();
    let cleaned = 0;
    const details = [];
    for (const group of data.groups) {
      const seen = new Set();
      const unique = [];
      for (const uid of group.uids) {
        const uidNum = Number(uid);
        if (isNaN(uidNum) || seen.has(uidNum)) {
          cleaned++;
          continue;
        }
        seen.add(uidNum);
        unique.push(uidNum);
      }
      if (unique.length !== group.uids.length) {
        details.push({ group: group.name, removed: group.uids.length - unique.length });
        group.uids = unique;
      }
    }
    if (cleaned > 0) {
      await this._save(data);
    }
    return { cleaned, details };
  },

  async removeUidFromGroup(groupId, uid) {
    const data = await this._load();
    const group = data.groups.find(g => g.id === groupId);
    if (group) {
      group.uids = group.uids.filter(u => u !== uid);
      await this._save(data);
    }
  },

  // ==================== 查询接口 ====================

  async getBlockedUids() {
    const data = await this._load();
    const uidSet = new Set();
    for (const group of data.groups) {
      if (group.enabled) {
        group.uids.forEach(uid => uidSet.add(uid));
      }
    }
    return uidSet;
  },

  async isBlocked(uid) {
    const blocked = await this.getBlockedUids();
    return blocked.has(uid);
  },

  /**
   * 查找 UID 所在的所有分组（不区分启用/禁用）
   * 用于空间主页提醒：用户可能添加过后又禁用了分组，但仍需提醒
   * @param {number|string} uid
   * @returns {Promise<Array<{id,name,enabled}>>}
   */
  async findGroupsByUid(uid) {
    const data = await this._load();
    const uidNum = Number(uid);
    const matched = [];
    for (const group of data.groups) {
      if (group.uids.includes(uidNum)) {
        matched.push({ id: group.id, name: group.name, enabled: group.enabled });
      }
    }
    return matched;
  },

  // ==================== 导入导出 ====================

  async exportData() {
    const data = await this._load();
    return JSON.stringify(data, null, 2);
  },

  async importData(jsonString, mode = 'merge') {
    const imported = JSON.parse(jsonString);
    if (!imported.groups || !Array.isArray(imported.groups)) {
      throw new Error('无效的导入数据格式');
    }

    if (mode === 'replace') {
      await this._save(imported);
      return;
    }

    const data = await this._load();
    for (const impGroup of imported.groups) {
      let existing = data.groups.find(g => g.name === impGroup.name);
      if (!existing) {
        existing = {
          id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: impGroup.name,
          enabled: impGroup.enabled !== false,
          uids: []
        };
        data.groups.push(existing);
      }
      for (const uid of (impGroup.uids || [])) {
        const uidNum = Number(uid);
        if (!isNaN(uidNum) && !existing.uids.includes(uidNum)) {
          existing.uids.push(uidNum);
        }
      }
    }
    await this._save(data);
  },

  // ==================== 订阅源管理 ====================

  async getSources() {
    const result = await chrome.storage.local.get(this.SOURCES_KEY);
    return result[this.SOURCES_KEY] || [];
  },

  async addSource(source) {
    const sources = await this.getSources();
    // 去重：同一 repo+path 不重复添加
    const exists = sources.find(s =>
      s.owner === source.owner && s.repo === source.repo && s.path === source.path
    );
    if (exists) return exists;

    const newSource = {
      id: 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      owner: source.owner,
      repo: source.repo,
      path: source.path || 'blacklist.json',
      branch: source.branch || 'main',
      name: source.name || (source.owner + '/' + source.repo),
      chunks: source.chunks || []
    };
    sources.push(newSource);
    await chrome.storage.local.set({ [this.SOURCES_KEY]: sources });
    return newSource;
  },

  async removeSource(sourceId) {
    const sources = await this.getSources();
    const filtered = sources.filter(s => s.id !== sourceId);
    await chrome.storage.local.set({ [this.SOURCES_KEY]: filtered });
  },

  async updateSourceChunks(sourceId, chunks) {
    const sources = await this.getSources();
    const source = sources.find(s => s.id === sourceId);
    if (source) {
      source.chunks = chunks;
      await chrome.storage.local.set({ [this.SOURCES_KEY]: sources });
    }
  },

  async pullFromSource(source) {
    const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.branch}/${source.path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`获取失败: ${response.status}`);
    }
    const data = await response.json();
    if (!data.groups || !Array.isArray(data.groups)) {
      throw new Error('仓库中的文件格式无效');
    }
    return data;
  },

  async pullChunkFromSource(source, chunkPath) {
    const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.branch}/${chunkPath}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`获取失败: ${response.status}`);
    }
    const data = await response.json();
    if (!data.groups || !Array.isArray(data.groups)) {
      throw new Error('仓库中的文件格式无效');
    }
    return data;
  },

  async fetchSourceChunks(source) {
    // 尝试获取仓库的目录结构，找到所有 .json 文件
    try {
      const apiUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/?ref=${source.branch}`;
      const response = await fetch(apiUrl);
      if (!response.ok) return [];
      
      const contents = await response.json();
      const jsonFiles = contents
        .filter(item => item.type === 'file' && item.name.endsWith('.json'))
        .map(item => ({
          name: item.name.replace('.json', ''),
          path: item.path,
          size: item.size
        }));
      
      return jsonFiles;
    } catch (e) {
      // 如果 API 请求失败，返回主文件
      return [{
        name: source.name || 'blacklist',
        path: source.path,
        size: 0
      }];
    }
  },

  async pullFromAllSources() {
    const sources = await this.getSources();
    const results = [];
    const errors = [];

    for (const source of sources) {
      try {
        const data = await this.pullFromSource(source);
        results.push({ source, data });
      } catch (e) {
        errors.push({ source, error: e.message });
      }
    }

    return { results, errors };
  },

  async mergeSourcesIntoLocal() {
    const { results, errors } = await this.pullFromAllSources();
    const data = await this._load();

    let totalMerged = 0;
    for (const { data: remoteData } of results) {
      for (const remoteGroup of (remoteData.groups || [])) {
        let localGroup = data.groups.find(g => g.name === remoteGroup.name);
        if (!localGroup) {
          localGroup = {
            id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            name: remoteGroup.name,
            enabled: true,
            uids: []
          };
          data.groups.push(localGroup);
        }
        for (const uid of (remoteGroup.uids || [])) {
          const uidNum = Number(uid);
          if (!isNaN(uidNum) && !localGroup.uids.includes(uidNum)) {
            localGroup.uids.push(uidNum);
            totalMerged++;
          }
        }
      }
    }

    await this._save(data);
    return { merged: totalMerged, results: results.length, errors };
  }
};
