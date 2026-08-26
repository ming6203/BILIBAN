/**
 * BILIBAN GitHub Repo Sync
 * 使用 GitHub Repository API 同步备份黑名单数据到 bili-Blacklist 仓库
 * 支持分块备份：每个块对应一个 JSON 文件
 *
 * v2 块文件格式（按 chunkId 寻址，文件名仅为展示用途）：
 * {
 *   "version": 2,
 *   "chunkId": "chk_...",    // 块的唯一身份，创建后永不变更
 *   "chunkName": "广告号",    // 展示名，重命名后随下次推送更新到文件名
 *   "groups": [...]
 * }
 *
 * 同步规则：
 * - 推送：按 chunkId 定位云端文件；改名后自动 PUT 新文件名 + DELETE 旧文件名
 * - 拉取：优先按 chunkId 匹配，云端 chunkId 为准（本地块身份向云端对齐）
 * - 兼容模式：无 chunkId 的旧格式文件，文件名与本地块名一致时可认领并升级为 v2；
 *   否则视为孤儿文件直接忽略，不参与同步、不删除
 * - blacklist.json（旧版整体备份）永不参与块同步
 */

const BilibanGithubSync = {

  API_BASE: 'https://api.github.com',
  REPO_NAME: 'BILI-Blacklist',
  COMMIT_MSG: 'BILIBAN: 更新黑名单备份',
  REPO_VISIBILITY_KEY: 'biliban_repo_visibility',

  // 旧版整体备份文件名，不参与块同步：既不认领也不清理
  LEGACY_FILE: 'blacklist',

  // ==================== Token 管理 ====================

  async getToken() {
    const result = await chrome.storage.local.get('biliban_github_token');
    return result.biliban_github_token || '';
  },

  async setToken(token) {
    await chrome.storage.local.set({ biliban_github_token: token });
  },

  async getUsername() {
    const result = await chrome.storage.local.get('biliban_github_username');
    return result.biliban_github_username || '';
  },

  async setUsername(username) {
    await chrome.storage.local.set({ biliban_github_username: username });
  },

  // ==================== 仓库可见性 ====================

  // 读取用户偏好：true=私有, false=公共（默认私有）
  async getRepoVisibilityPref() {
    const result = await chrome.storage.local.get(this.REPO_VISIBILITY_KEY);
    return result[this.REPO_VISIBILITY_KEY] !== false;
  },

  async setRepoVisibilityPref(isPrivate) {
    await chrome.storage.local.set({ [this.REPO_VISIBILITY_KEY]: isPrivate });
  },

  // 根据偏好修改仓库可见性（PATCH /repos/:owner/:repo）
  // repoPath 可省略，省略时自动获取；仓库不存在时仅返回未创建状态（等推送时创建）
  async syncRepoVisibility(repoPath) {
    if (!repoPath) {
      repoPath = await this.getRepoFullName();
    }
    const isPrivate = await this.getRepoVisibilityPref();
    let repo;
    try {
      repo = await this.request('/repos/' + repoPath);
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        return { changed: false, isPrivate: isPrivate, created: false };
      }
      throw e;
    }
    if (repo.private !== isPrivate) {
      await this.request('/repos/' + repoPath, {
        method: 'PATCH',
        body: JSON.stringify({ private: isPrivate })
      });
      return { changed: true, isPrivate: isPrivate };
    }
    return { changed: false, isPrivate: repo.private };
  },

  // ==================== API 请求 ====================

  async request(endpoint, options = {}) {
    const token = await this.getToken();
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers
    };

    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const response = await fetch(this.API_BASE + endpoint, {
      ...options,
      headers
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'GitHub API 错误: ' + response.status);
    }

    // 204 No Content
    if (response.status === 204) return null;

    return response.json();
  },

  // ==================== 验证 Token ====================

  async validateToken() {
    try {
      const user = await this.request('/user');
      await this.setUsername(user.login);
      return { valid: true, username: user.login, avatar: user.avatar_url };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  },

  // ==================== 仓库操作 ====================

  // 获取当前用户的用户名
  async getRepoFullName() {
    const username = await this.getUsername();
    if (!username) {
      const user = await this.request('/user');
      await this.setUsername(user.login);
      return user.login + '/' + this.REPO_NAME;
    }
    return username + '/' + this.REPO_NAME;
  },

  // 检查并创建仓库；若仓库已存在则按偏好同步可见性
  async ensureRepo() {
    const repoPath = await this.getRepoFullName();
    const isPrivate = await this.getRepoVisibilityPref();
    try {
      await this.request('/repos/' + repoPath);
      // 仓库已存在，同步可见性（公共↔私有）
      await this.syncRepoVisibility(repoPath);
      return repoPath;
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        // 仓库不存在，按偏好创建
        await this.request('/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name: this.REPO_NAME,
            description: 'BILIBAN - B站用户屏蔽黑名单备份',
            private: isPrivate,
            auto_init: true
          })
        });
        return repoPath;
      }
      throw e;
    }
  },

  // 获取文件信息（含 SHA）
  async getFileInfo(filePath) {
    const repoPath = await this.getRepoFullName();
    try {
      const file = await this.request('/repos/' + repoPath + '/contents/' + filePath);
      return { sha: file.sha, exists: true };
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        return { sha: null, exists: false };
      }
      throw e;
    }
  },

  // ==================== 云端块扫描（v2：按 chunkId 寻址） ====================

  /**
   * 列出云端所有 .json 块文件并解析内容。
   * 返回 [{ name, path, sha, size, url, chunkId, chunkName, valid, data }]
   * - valid = true：v2 格式（含 chunkId），身份明确，参与按 id 同步
   * - valid = false：旧格式/无法解析（含 blacklist.json），仅可按文件名认领；
   *   认领不了的视为孤儿文件，一律忽略（兼容模式）
   */
  async listCloudChunks() {
    const repoPath = await this.getRepoFullName();
    let contents;
    try {
      contents = await this.request('/repos/' + repoPath + '/contents/');
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        return [];
      }
      throw e;
    }

    const result = [];
    for (const item of contents) {
      if (item.type !== 'file' || !item.name.endsWith('.json')) continue;

      const entry = {
        name: item.name.replace('.json', ''),
        path: item.path,
        sha: item.sha,
        size: item.size,
        url: item.html_url,
        chunkId: null,
        chunkName: null,
        valid: false,
        data: null
      };

      // 旧版整体备份不参与块同步，不解析内容
      if (entry.name === this.LEGACY_FILE) {
        result.push(entry);
        continue;
      }

      try {
        const file = await this.request('/repos/' + repoPath + '/contents/' + item.path);
        const jsonStr = decodeURIComponent(escape(atob(file.content)));
        const parsed = JSON.parse(jsonStr);
        entry.data = parsed;
        if (parsed && typeof parsed.chunkId === 'string' && parsed.chunkId) {
          entry.chunkId = parsed.chunkId;
          entry.chunkName = (typeof parsed.chunkName === 'string' && parsed.chunkName) || entry.name;
          entry.valid = true;
        }
      } catch (e) {
        // 内容获取/解析失败（含超大文件）→ 按旧格式处理
      }
      result.push(entry);
    }
    return result;
  },

  // 文件名清理：去掉路径非法字符
  _sanitizeFileName(name) {
    return String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'chunk';
  },

  // 文件名是否被占用：旧版整体备份，或属于其他块（chunkId 不同）的 v2 文件。
  // 同名的旧格式孤儿文件可被认领（覆盖升级为 v2），不算占用。
  _nameTaken(cloudChunks, name, chunkId) {
    return cloudChunks.some(c =>
      c.name === name && (c.name === this.LEGACY_FILE || (c.valid && c.chunkId !== chunkId))
    );
  },

  // 找一个不冲突的文件名：名字、名字-2、名字-3 ...
  _freeName(cloudChunks, name, chunkId) {
    let candidate = name;
    let n = 2;
    while (this._nameTaken(cloudChunks, candidate, chunkId)) {
      candidate = name + '-' + (n++);
    }
    return candidate;
  },

  // ==================== 分块推送 / 拉取 ====================

  // 写入（或覆盖）一个 JSON 文件；sha 存在时为更新，否则为新建
  async _putFile(fileName, payload, sha) {
    const repoPath = await this.getRepoFullName();
    const filePath = fileName + '.json';
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    const body = {
      message: this.COMMIT_MSG + ' (' + fileName + ')',
      content: content
    };
    if (sha) body.sha = sha;

    const result = await this.request('/repos/' + repoPath + '/contents/' + filePath, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    return { url: result.content.html_url };
  },

  // 删除云端文件（entry 来自 listCloudChunks，含 path 和 sha）
  async _deleteFile(entry) {
    const repoPath = await this.getRepoFullName();
    await this.request('/repos/' + repoPath + '/contents/' + entry.path, {
      method: 'DELETE',
      body: JSON.stringify({
        message: this.COMMIT_MSG + ': 清理旧文件 ' + entry.name,
        sha: entry.sha
      })
    });
  },

  /**
   * 推送单个块（v2：按 chunkId 寻址）
   * @param chunk { id, name } 本地块对象
   * @param data  { groups } getChunkData() 的结果
   * 流程：
   * 1. 扫描云端，按 chunkId 找到本块现有文件（可能还是旧名字）
   * 2. 目标文件名 = 当前块名（被其他块占用时自动加 -2/-3 后缀）
   * 3. PUT 新文件（若目标位置是旧格式孤儿文件，顺手认领升级为 v2）
   * 4. 若本块旧文件的文件名与目标不同（重命名场景），DELETE 旧文件
   */
  async pushChunk(chunk, data) {
    await this.ensureRepo();

    const payload = {
      version: 2,
      chunkId: chunk.id,
      chunkName: chunk.name,
      groups: (data && data.groups) || []
    };

    const cloudChunks = await this.listCloudChunks();

    // 本块现有的云端文件（可能仍是旧名字）
    const mine = cloudChunks.find(c => c.valid && c.chunkId === chunk.id) || null;

    // 目标文件名：当前块名（清理非法字符），被其他块占用时追加后缀
    const baseName = this._sanitizeFileName(chunk.name);
    const targetName = this._freeName(cloudChunks, baseName, chunk.id);

    // 目标位置上已有的文件（可能是待认领的旧格式文件）
    const existing = cloudChunks.find(c => c.name === targetName) || null;

    // 写入目标文件
    const result = await this._putFile(targetName, payload, existing ? existing.sha : null);

    // 旧名字的文件（id 相同但文件名不同）→ 重命名后清理，杜绝孤儿文件
    if (mine && mine.name !== targetName) {
      await this._deleteFile(mine);
    }

    let message;
    if (mine && mine.name !== targetName) {
      message = '块「' + chunk.name + '」已更新（文件由「' + mine.name + '」重命名）';
    } else if (existing) {
      message = existing.valid
        ? '块「' + chunk.name + '」已更新'
        : '块「' + chunk.name + '」已更新（旧格式文件已认领升级）';
    } else {
      message = '块「' + chunk.name + '」已创建';
    }

    return { success: true, url: result.url, message: message };
  },

  // 推送全部数据（单个文件 blacklist.json，兼容旧版；保持 v1 格式，不参与块同步）
  async push(data) {
    await this.ensureRepo();
    const fileInfo = await this.getFileInfo(this.LEGACY_FILE + '.json');
    const result = await this._putFile(this.LEGACY_FILE, data, fileInfo.sha);
    return {
      success: true,
      url: result.url,
      message: fileInfo.exists ? '黑名单已更新' : '黑名单已创建'
    };
  },

  /**
   * 拉取单个块（v2：优先按 chunkId 匹配）
   * @param chunk { id, name } 本地块对象
   * 匹配顺序：
   * 1. 云端 v2 文件中 chunkId 与本地一致 → 命中（文件名无关紧要）
   * 2. 文件名与本地块名一致的非 legacy 文件 → 命中（旧格式认领 / v2 重名认领）
   * 3. 都没有 → 报错
   * 返回的 chunkId 以云端为准，由调用方将本地块身份对齐（拉到的 id 就用哪个）
   */
  async pullChunk(chunk) {
    const cloudChunks = await this.listCloudChunks();

    let target = cloudChunks.find(c => c.valid && c.chunkId === chunk.id) || null;
    if (!target) {
      target = cloudChunks.find(c => c.name === chunk.name && c.name !== this.LEGACY_FILE) || null;
    }
    if (!target) {
      throw new Error('云端未找到块「' + chunk.name + '」的备份');
    }
    if (!target.data || !Array.isArray(target.data.groups)) {
      throw new Error('云端文件「' + target.name + '.json」格式无效');
    }

    return {
      success: true,
      data: { groups: target.data.groups },
      chunkId: target.chunkId || null,  // v2 才有；旧格式为 null（不采用，保留本地 id）
      chunkName: target.chunkName || target.name,
      message: '块「' + chunk.name + '」恢复成功'
    };
  },

  // 拉取全部数据（blacklist.json，兼容旧版）
  async pull() {
    const repoPath = await this.getRepoFullName();
    const file = await this.request('/repos/' + repoPath + '/contents/' + this.LEGACY_FILE + '.json');
    const jsonStr = decodeURIComponent(escape(atob(file.content)));
    const data = JSON.parse(jsonStr);
    return { success: true, data: data, message: '黑名单恢复成功' };
  },

  // 获取同步状态（云端块按 v2 有效文件统计，孤儿文件单独提示）
  async getSyncStatus() {
    const token = await this.getToken();
    if (!token) return { configured: false, reason: '未配置 Token' };

    try {
      const repoPath = await this.getRepoFullName();
      const repo = await this.request('/repos/' + repoPath);

      try {
        const cloud = await this.listCloudChunks();
        const valid = cloud.filter(c => c.valid);
        const orphans = cloud.filter(c => !c.valid && c.name !== this.LEGACY_FILE);

        let message;
        if (valid.length > 0) {
          message = '已备份 ' + valid.length + ' 个块';
          if (orphans.length > 0) message += '，' + orphans.length + ' 个旧格式文件已忽略';
        } else if (orphans.length > 0) {
          message = '发现 ' + orphans.length + ' 个旧格式文件（推送同名块后自动认领）';
        } else {
          message = '仓库已创建，尚无备份';
        }

        return {
          configured: true,
          synced: valid.length > 0,
          chunks: valid.map(c => ({ name: c.chunkName || c.name, chunkId: c.chunkId, url: c.url })),
          updatedAt: repo.updated_at,
          isPrivate: repo.private,
          message: message
        };
      } catch (e) {
        return { configured: true, synced: false, isPrivate: repo.private, reason: '仓库已创建，尚无备份' };
      }
    } catch (e) {
      return { configured: true, synced: false, reason: '未创建云端仓库' };
    }
  },

  /**
   * 删除云端块文件（本地块删除时联动清理）
   * @param chunk { id, name } 本地块对象
   * 匹配顺序：按 chunkId → 按文件名（旧格式认领文件）
   * blacklist.json 永不删除
   */
  async deleteChunk(chunk) {
    const cloudChunks = await this.listCloudChunks();

    let target = cloudChunks.find(c => c.valid && c.chunkId === chunk.id) || null;
    if (!target) {
      target = cloudChunks.find(c => c.name === chunk.name && c.name !== this.LEGACY_FILE) || null;
    }
    if (!target) {
      return { success: true, deleted: false, message: '云端无此块的备份' };
    }

    await this._deleteFile(target);
    return { success: true, deleted: true, message: '云端文件「' + target.name + '.json」已删除' };
  }
};