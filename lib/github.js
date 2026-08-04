/**
 * BILIBAN GitHub Repo Sync
 * 使用 GitHub Repository API 同步备份黑名单数据到 bili-Blacklist 仓库
 */

const BilibanGithubSync = {

  API_BASE: 'https://api.github.com',
  REPO_NAME: 'BILI-Blacklist',
  FILE_PATH: 'blacklist.json',
  COMMIT_MSG: 'BILIBAN: 更新黑名单备份',

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

  // 检查并创建仓库
  async ensureRepo() {
    const repoPath = await this.getRepoFullName();
    try {
      await this.request('/repos/' + repoPath);
      return repoPath;
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        // 仓库不存在，创建它
        await this.request('/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name: this.REPO_NAME,
            description: 'BILIBAN - B站用户屏蔽黑名单备份',
            private: true,
            auto_init: true
          })
        });
        return repoPath;
      }
      throw e;
    }
  },

  // 获取文件信息（含 SHA）
  async getFileInfo() {
    const repoPath = await this.getRepoFullName();
    try {
      const file = await this.request('/repos/' + repoPath + '/contents/' + this.FILE_PATH);
      return { sha: file.sha, exists: true };
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not Found')) {
        return { sha: null, exists: false };
      }
      throw e;
    }
  },

  // ==================== 推送 / 拉取 ====================

  // 推送到仓库
  async push(data) {
    const repoPath = await this.ensureRepo();
    const jsonData = JSON.stringify(data, null, 2);
    const content = btoa(unescape(encodeURIComponent(jsonData)));

    const fileInfo = await this.getFileInfo();
    const body = {
      message: this.COMMIT_MSG,
      content: content
    };
    if (fileInfo.sha) {
      body.sha = fileInfo.sha;
    }

    const result = await this.request('/repos/' + repoPath + '/contents/' + this.FILE_PATH, {
      method: 'PUT',
      body: JSON.stringify(body)
    });

    return {
      success: true,
      url: result.content.html_url,
      message: fileInfo.exists ? '备份已更新' : '备份已创建'
    };
  },

  // 从仓库拉取
  async pull() {
    const repoPath = await this.getRepoFullName();
    const file = await this.request('/repos/' + repoPath + '/contents/' + this.FILE_PATH);

    const jsonStr = decodeURIComponent(escape(atob(file.content)));
    const data = JSON.parse(jsonStr);

    return {
      success: true,
      data: data,
      message: '恢复成功'
    };
  },

  // 获取同步状态
  async getSyncStatus() {
    const token = await this.getToken();
    if (!token) return { configured: false, reason: '未配置 Token' };

    try {
      const repoPath = await this.getRepoFullName();
      const repo = await this.request('/repos/' + repoPath);

      try {
        const file = await this.request('/repos/' + repoPath + '/contents/' + this.FILE_PATH);
        return {
          configured: true,
          synced: true,
          url: file.html_url,
          updatedAt: repo.updated_at,
          size: file.size
        };
      } catch (e) {
        return { configured: true, synced: false, reason: '仓库已创建，尚无备份' };
      }
    } catch (e) {
      return { configured: true, synced: false, reason: '未创建云端仓库' };
    }
  }
};
