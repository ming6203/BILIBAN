/**
 * BILIBAN GitHub Repo Sync
 * 使用 GitHub Repository API 同步备份黑名单数据到 bili-Blacklist 仓库
 * 支持分块备份：每个块对应一个 JSON 文件
 */

const BilibanGithubSync = {

  API_BASE: 'https://api.github.com',
  REPO_NAME: 'BILI-Blacklist',
  COMMIT_MSG: 'BILIBAN: 更新黑名单备份',
  REPO_VISIBILITY_KEY: 'biliban_repo_visibility',

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

  // 获取仓库中的所有块文件
  async listChunkFiles() {
    const repoPath = await this.getRepoFullName();
    try {
      const contents = await this.request('/repos/' + repoPath + '/contents/');
      return contents
        .filter(item => item.type === 'file' && item.name.endsWith('.json'))
        .map(item => ({
          name: item.name.replace('.json', ''),
          path: item.path,
          sha: item.sha,
          size: item.size,
          url: item.html_url
        }));
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        return [];
      }
      throw e;
    }
  },

  // ==================== 分块推送 / 拉取 ====================

  // 推送单个块到仓库
  async pushChunk(chunkName, data) {
    const repoPath = await this.ensureRepo();
    const filePath = chunkName + '.json';
    const jsonData = JSON.stringify(data, null, 2);
    const content = btoa(unescape(encodeURIComponent(jsonData)));

    const fileInfo = await this.getFileInfo(filePath);
    const body = {
      message: this.COMMIT_MSG + ' (' + chunkName + ')',
      content: content
    };
    if (fileInfo.sha) {
      body.sha = fileInfo.sha;
    }

    const result = await this.request('/repos/' + repoPath + '/contents/' + filePath, {
      method: 'PUT',
      body: JSON.stringify(body)
    });

    return {
      success: true,
      url: result.content.html_url,
      message: fileInfo.exists ? '块「' + chunkName + '」已更新' : '块「' + chunkName + '」已创建'
    };
  },

  // 推送全部数据（单个文件，兼容旧版）
  async push(data) {
    return this.pushChunk('blacklist', data);
  },

  // 拉取单个块
  async pullChunk(chunkName) {
    const repoPath = await this.getRepoFullName();
    const filePath = chunkName + '.json';
    const file = await this.request('/repos/' + repoPath + '/contents/' + filePath);

    const jsonStr = decodeURIComponent(escape(atob(file.content)));
    const data = JSON.parse(jsonStr);

    return {
      success: true,
      data: data,
      message: '块「' + chunkName + '」恢复成功'
    };
  },

  // 拉取全部数据（兼容旧版）
  async pull() {
    return this.pullChunk('blacklist');
  },

  // 获取同步状态
  async getSyncStatus() {
    const token = await this.getToken();
    if (!token) return { configured: false, reason: '未配置 Token' };

    try {
      const repoPath = await this.getRepoFullName();
      const repo = await this.request('/repos/' + repoPath);

      try {
        const chunks = await this.listChunkFiles();
        return {
          configured: true,
          synced: chunks.length > 0,
          chunks: chunks,
          updatedAt: repo.updated_at,
          isPrivate: repo.private,
          message: chunks.length > 0 ? '已备份 ' + chunks.length + ' 个块' : '仓库已创建，尚无备份'
        };
      } catch (e) {
        return { configured: true, synced: false, isPrivate: repo.private, reason: '仓库已创建，尚无备份' };
      }
    } catch (e) {
      return { configured: true, synced: false, reason: '未创建云端仓库' };
    }
  },

  // 删除云端文件
  async deleteChunk(chunkName) {
    const repoPath = await this.getRepoFullName();
    const filePath = chunkName + '.json';
    const fileInfo = await this.getFileInfo(filePath);
    
    if (!fileInfo.exists) {
      return { success: true, message: '文件不存在' };
    }

    await this.request('/repos/' + repoPath + '/contents/' + filePath, {
      method: 'DELETE',
      body: JSON.stringify({
        message: this.COMMIT_MSG + ': 删除 ' + chunkName,
        sha: fileInfo.sha
      })
    });

    return { success: true, message: '已删除' };
  }
};
