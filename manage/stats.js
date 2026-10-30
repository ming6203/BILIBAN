/**
 * BILIBAN 数据面板 (stats.js)
 * 黑名单使用情况统计：概览卡 + Canvas 频率折线图（纯原生，无外部依赖）
 * 数据只包含屏蔽时间与类型（video / comment 两个时间戳数组）。
 * 由 manage.js 在切换到「数据面板」「高级设置」tab 时调用对应方法。
 */

(function() {
  'use strict';

  const DEFAULTS = {
    recordComment: true,
    recordVideo: true
  };

  // DOM
  const el = {
    total: document.getElementById('stat-total'),
    video: document.getElementById('stat-video'),
    comment: document.getElementById('stat-comment'),
    d7: document.getElementById('stat-7d'),
    storage: document.getElementById('stat-storage'),
    storageLabel: document.getElementById('stat-storage-label'),
    granularity: document.getElementById('stats-granularity'),
    range: document.getElementById('stats-range'),
    canvas: document.getElementById('stats-chart'),
    empty: document.getElementById('stats-chart-empty'),
    refresh: document.getElementById('stats-refresh'),
    clear: document.getElementById('stats-clear'),
    cleanupTime: document.getElementById('stats-cleanup-time'),
    hint: document.getElementById('stats-hint')
  };

  let currentStats = null;   // 最近一次 getBlockStats 结果

  function setHint(text, color) {
    if (!el.hint) return;
    el.hint.textContent = text || '';
    el.hint.style.color = color || '';
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // datetime-local 需要 YYYY-MM-DDTHH:mm（本地时间，分钟精度）
  function toInputValue(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + 'T' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function parseCleanupTime() {
    if (!el.cleanupTime || !el.cleanupTime.value) return null;
    const t = new Date(el.cleanupTime.value).getTime();
    return Number.isFinite(t) ? t : null;
  }

  // ---------- 概览卡 ----------
  function renderOverview(stats) {
    el.total.textContent = stats.total;
    el.video.textContent = stats.videoCount;
    el.comment.textContent = stats.commentCount;

    // 近 7 天：从按天 buckets 计算
    let d7 = 0;
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      d7 += (stats.buckets[key] || 0);
    }
    el.d7.textContent = d7;
  }

  // ---------- 存储占用 / 清理时间 ----------
  function renderStorage(info) {
    if (!el.storage) return;
    el.storage.textContent = fmtBytes(info.bytes || 0);
    if (el.storageLabel) {
      el.storageLabel.textContent = '存储占用 · ' + info.total + ' 条';
    }

    const hasData = info.total > 0;
    if (el.cleanupTime) {
      el.cleanupTime.disabled = !hasData;
      if (hasData) {
        // 默认显示已有数据的最早时间；点击「清理数据」时清理该时间之前（不含该时间）
        el.cleanupTime.value = toInputValue(info.firstTimestamp);
        el.cleanupTime.title = '最早数据：' + fmtDateTime(info.firstTimestamp) +
          '；将清理该时间之前的数据（不含该时间点）';
      } else {
        el.cleanupTime.value = '';
        el.cleanupTime.title = '暂无数据';
      }
    }
    if (el.clear) el.clear.disabled = !hasData;
  }

  // ---------- 数据聚合 ----------
  // buckets: { 'YYYY-MM-DD': count }，聚合到 day/week/month 序列
  function aggregateSeries(buckets, granularity, rangeDays) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(today);
    start.setDate(start.getDate() - (rangeDays - 1));

    const pointKey = (d, g) => {
      if (g === 'month') return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (g === 'week') {
        const day = (d.getDay() + 6) % 7;  // 周一为一周起点
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
        return monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
      }
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const label = (d, g) => {
      if (g === 'month') return d.getFullYear() + '/' + (d.getMonth() + 1);
      if (g === 'week') {
        const day = (d.getDay() + 6) % 7;
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
        return (monday.getMonth() + 1) + '/' + monday.getDate() + '周';
      }
      return (d.getMonth() + 1) + '/' + d.getDate();
    };

    // 生成从 start 到 today 的所有时间点（含空值，保证曲线连续）
    const series = [];
    const index = new Map();
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const k = pointKey(d, granularity);
      if (!index.has(k)) {
        const item = { key: k, label: label(d, granularity), value: 0 };
        index.set(k, series.length);
        series.push(item);
      }
    }
    // 填入 bucket 数据：bucket 是日粒度 key(YYYY-MM-DD)，需按目标粒度换算后累加
    for (const key of Object.keys(buckets || {})) {
      const dm = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!dm) continue;
      const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
      if (isNaN(d.getTime()) || d < start || d > today) continue;
      const k = pointKey(d, granularity);
      if (index.has(k)) series[index.get(k)].value += buckets[key] || 0;
    }
    return series;
  }

  // ---------- Canvas 折线图 ----------
  function drawChart(stats) {
    const canvas = el.canvas;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const padL = 36, padR = 12, padT = 16, padB = 26;
    ctx.clearRect(0, 0, W, H);

    const granularity = el.granularity.value;
    const rangeDays = Number(el.range.value);
    const series = aggregateSeries(stats.buckets || {}, granularity, rangeDays);
    const values = series.map(s => s.value);
    const maxVal = Math.max(1, ...values);
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // 网格 + Y 轴
    ctx.strokeStyle = '#3a3a3a';
    ctx.fillStyle = '#888';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const y = padT + plotH - (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      const v = Math.round((i / yTicks) * maxVal);
      ctx.fillText(String(v), padL - 4, y + 3);
    }

    // X 轴标签（稀疏显示）
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(series.length / 8));
    series.forEach((s, i) => {
      if (i % step === 0) {
        const x = padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        ctx.fillText(s.label, x, H - 8);
      }
    });

    // 三条折线：total / video / comment
    const colors = { total: '#fb7299', video: '#00a1d6', comment: '#ffd700' };
    const videoB = stats.videoBuckets || {};
    const commentB = stats.commentBuckets || {};
    const plotLines = [
      { key: 'total', data: series.map(s => s.value) },
      { key: 'video', data: series.map(s => videoB[s.key] || 0) },
      { key: 'comment', data: series.map(s => commentB[s.key] || 0) }
    ];

    for (const line of plotLines) {
      ctx.strokeStyle = colors[line.key];
      ctx.lineWidth = 2;
      ctx.beginPath();
      series.forEach((s, i) => {
        const x = padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        const y = padT + plotH - (line.data[i] / maxVal) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 数据点（total 用实心点）
    ctx.fillStyle = colors.total;
    series.forEach((s, i) => {
      if (s.value > 0) {
        const x = padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        const y = padT + plotH - (s.value / maxVal) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // ---------- 主渲染 ----------
  async function render() {
    setHint('');
    try {
      const stats = await BilibanStorage.getBlockStats();
      currentStats = stats;
      renderOverview(stats);

      const info = await BilibanStorage.getBlockStorageInfo();
      renderStorage(info);

      const hasData = stats.total > 0;
      if (!hasData) {
        el.canvas.style.display = 'none';
        el.empty.style.display = 'block';
      } else {
        el.canvas.style.display = 'block';
        el.empty.style.display = 'none';
        drawChart(stats);
      }

      const writeError = await BilibanStorage.getBlockWriteError();
      if (writeError) {
        setHint('⚠️ 数据写入失败：' + (writeError.message || '存储空间不足') + '。可清理旧数据后重试', '#ffd700');
      }
    } catch (e) {
      setHint('数据面板渲染失败：' + (e.message || e), '#ff4d4f');
    }
  }

  // ---------- 事件 ----------
  if (el.refresh) el.refresh.addEventListener('click', render);
  if (el.granularity) el.granularity.addEventListener('change', () => { if (currentStats) drawChart(currentStats); });
  if (el.range) el.range.addEventListener('change', () => { if (currentStats) drawChart(currentStats); });

  if (el.clear) {
    el.clear.addEventListener('click', async () => {
      const cutoff = parseCleanupTime();
      if (!cutoff) {
        setHint('请先选择清理时间', '#ffd700');
        return;
      }

      try {
        const counts = await BilibanStorage.countBlockEventsBefore(cutoff);
        if (counts.total === 0) {
          setHint('所选时间之前没有数据（不会删除任何记录）', '#ffd700');
          return;
        }

        const ok = confirm(
          '确定清理 ' + fmtDateTime(cutoff) + ' 之前的 ' + counts.total + ' 条记录吗？\n' +
          '其中视频 ' + counts.video + ' 条、评论 ' + counts.comment + ' 条。\n' +
          '该时间点及之后的记录会保留，操作不可恢复。'
        );
        if (!ok) return;

        el.clear.disabled = true;
        const result = await BilibanStorage.clearBlockEventsBefore(cutoff);
        await render();
        setHint('✅ 已清理 ' + result.removed + ' 条记录，剩余 ' + result.remaining + ' 条', '#7ecb20');
      } catch (e) {
        setHint('清理失败：' + (e.message || e), '#ff4d4f');
      } finally {
        if (currentStats && currentStats.total > 0) el.clear.disabled = false;
      }
    });
  }

  // ---------- 高级设置：记录开关 ----------
  const advEl = {
    recordComment: document.getElementById('adv-record-comment'),
    recordVideo: document.getElementById('adv-record-video'),
    save: document.getElementById('adv-save'),
    reset: document.getElementById('adv-reset'),
    hint: document.getElementById('adv-hint')
  };

  function fillAdvForm(cfg) {
    if (advEl.recordComment) advEl.recordComment.checked = cfg.recordComment !== false;
    if (advEl.recordVideo) advEl.recordVideo.checked = cfg.recordVideo !== false;
  }

  function readAdvForm() {
    return {
      recordComment: advEl.recordComment ? advEl.recordComment.checked : true,
      recordVideo: advEl.recordVideo ? advEl.recordVideo.checked : true
    };
  }

  async function loadAdvSettings() {
    try {
      if (typeof BilibanStorage.getAdvancedSettings === 'function') {
        const saved = await BilibanStorage.getAdvancedSettings();
        fillAdvForm(Object.assign({}, DEFAULTS, saved || {}));
      } else {
        fillAdvForm(DEFAULTS);
      }
    } catch (e) {
      fillAdvForm(DEFAULTS);
    }
  }

  async function saveAdvSettings() {
    const cfg = readAdvForm();
    try {
      if (typeof BilibanStorage.setAdvancedSettings === 'function') {
        await BilibanStorage.setAdvancedSettings(cfg);
      }
      if (advEl.hint) {
        advEl.hint.textContent = '✅ 已保存，采集端即时生效';
        advEl.hint.style.color = '#7ecb20';
      }
    } catch (e) {
      if (advEl.hint) {
        advEl.hint.textContent = '保存失败：' + (e.message || e);
        advEl.hint.style.color = '#ff4d4f';
      }
    }
  }

  if (advEl.save) advEl.save.addEventListener('click', saveAdvSettings);
  if (advEl.reset) {
    advEl.reset.addEventListener('click', () => {
      fillAdvForm(DEFAULTS);
      saveAdvSettings();
    });
  }

  // ---------- GitHub 仓库设置 ----------
  const ghRepoEl = {
    name: document.getElementById('gh-repo-name'),
    save: document.getElementById('gh-repo-save'),
    hint: document.getElementById('gh-repo-hint')
  };

  async function saveGithubRepo() {
    if (typeof BilibanGithubSync === 'undefined') {
      ghRepoEl.hint.textContent = 'GitHub 模块未加载';
      ghRepoEl.hint.style.color = '#ff4d4f';
      return;
    }
    const name = (ghRepoEl.name.value || '').trim();
    if (name && !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
      ghRepoEl.hint.textContent = '仓库名只能包含字母、数字、点、下划线、连字符（1-100 字符）';
      ghRepoEl.hint.style.color = '#ff4d4f';
      return;
    }
    try {
      const saved = await BilibanGithubSync.setRepoName(name);
      ghRepoEl.name.value = saved;
      ghRepoEl.hint.textContent = '✅ 已保存，推送时使用该仓库';
      ghRepoEl.hint.style.color = '#7ecb20';
    } catch (e) {
      ghRepoEl.hint.textContent = '保存失败：' + (e.message || e);
      ghRepoEl.hint.style.color = '#ff4d4f';
    }
  }

  if (ghRepoEl.save) ghRepoEl.save.addEventListener('click', saveGithubRepo);

  // ---------- GitHub 账户设置 ----------
  const ghEl = {
    tokenInput: document.getElementById('gh-token-input'),
    visibility: document.getElementById('gh-visibility'),
    save: document.getElementById('gh-token-save'),
    status: document.getElementById('gh-account-status')
  };

  async function loadGithubAccount() {
    try {
      if (typeof BilibanGithubSync === 'undefined') return;
      if (typeof BilibanGithubSync.getRepoName === 'function') {
        ghRepoEl.name.value = await BilibanGithubSync.getRepoName();
      }
      const token = await BilibanGithubSync.getToken();
      if (token) ghEl.tokenInput.value = token;
      const isPrivate = await BilibanGithubSync.getRepoVisibilityPref();
      ghEl.visibility.value = isPrivate ? 'private' : 'public';
    } catch (e) { /* 忽略 */ }
  }

  async function saveGithubAccount() {
    if (typeof BilibanGithubSync === 'undefined') {
      ghEl.status.textContent = 'GitHub 模块未加载';
      ghEl.status.style.color = '#ff4d4f';
      return;
    }
    const token = ghEl.tokenInput.value.trim();
    if (!token) { ghEl.status.textContent = '请输入 Token'; ghEl.status.style.color = '#ff4d4f'; return; }
    ghEl.status.textContent = '验证中...';
    ghEl.status.style.color = '';
    try {
      await BilibanGithubSync.setToken(token);
      const result = await BilibanGithubSync.validateToken();
      if (result && result.valid) {
        // 保存可见性偏好
        await BilibanGithubSync.setRepoVisibilityPref(ghEl.visibility.value === 'private');
        ghEl.status.textContent = '✅ 已保存设置并连接: ' + result.username + '（可见性已保存）';
        ghEl.status.style.color = '#7ecb20';
      } else {
        ghEl.status.textContent = '✗ ' + (result && result.error ? result.error : 'Token 无效');
        ghEl.status.style.color = '#ff4d4f';
      }
    } catch (e) {
      ghEl.status.textContent = '✗ 验证失败: ' + (e.message || e);
      ghEl.status.style.color = '#ff4d4f';
    }
  }

  if (ghEl.save) ghEl.save.addEventListener('click', saveGithubAccount);
  if (ghEl.visibility) {
    ghEl.visibility.addEventListener('change', async () => {
      try {
        if (typeof BilibanGithubSync !== 'undefined') await BilibanGithubSync.setRepoVisibilityPref(ghEl.visibility.value === 'private');
      } catch (e) { /* 忽略 */ }
    });
  }

  // ---------- 对外接口 ----------
  window.__BILIBAN_STATS_UI__ = {
    render: render,
    loadAdvSettings: loadAdvSettings,
    loadGithubAccount: loadGithubAccount
  };
})();
