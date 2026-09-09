/**
 * BILIBAN 数据面板 (stats.js)
 * 黑名单使用情况统计：概览卡 + Canvas 频率折线图（纯原生，无外部依赖）
 * 由 manage.js 在切换到「数据面板」tab 时调用 __BILIBAN_STATS_UI__.render()
 */

(function() {
  'use strict';

  const DEFAULTS = {
    flushBatch: 50,
    flushInterval: 10,
    eventLimitMode: 'size',      // 数据面板限制模式：count | size（默认大小形式）
    maxEvents: 50000,            // 数量模式：事件条数上限
    maxEventsMB: 8,              // 大小模式：事件存储上限 MB
    overflowStrategy: 1,     // 超额策略：1=淘汰最早(默认) 2=停止记录 3=清空明细只留曲线
    byteWarnPct: 90,             // 告警百分比（两种模式共用）
    archiveMergeMB: 5,          // 归档分块阈值（MB），达到即新建/裂分
    archiveCleanPct: 50,        // 手动清理比例（%），删最旧 X% 已归档数据
    archiveAutoClean: false,    // 自动清理开关（上传归档后按限制模式保留策略）
    recordComment: true,
    recordVideo: true,
    recordSubtitle: false,
    saveVideoTitle: false,
    keepUidDetail: true
  };

  // DOM
  const el = {
    total: document.getElementById('stat-total'),
    video: document.getElementById('stat-video'),
    comment: document.getElementById('stat-comment'),
    d7: document.getElementById('stat-7d'),
    storage: document.getElementById('stat-storage'),
    granularity: document.getElementById('stats-granularity'),
    range: document.getElementById('stats-range'),
    canvas: document.getElementById('stats-chart'),
    empty: document.getElementById('stats-chart-empty'),
    refresh: document.getElementById('stats-refresh'),
    clear: document.getElementById('stats-clear'),
    hint: document.getElementById('stats-hint')
  };

  // 归档区 DOM
  const archEl = {
    refresh: document.getElementById('archive-refresh'),
    back: document.getElementById('archive-back'),
    status: document.getElementById('archive-status'),
    summary: document.getElementById('archive-summary'),
    cloudList: document.getElementById('archive-cloud-list'),
    downloadList: document.getElementById('archive-download-list')
  };

  // 归档视图状态（加载的分块数据）
  let archivedView = null;   // { name, dir }
  let archivedStats = null;

  let currentStats = null;   // 最近一次 getBlockStats 结果
  let tooltip = null;        // tooltip 元素

  // ---------- 概览卡 ----------
  function renderOverview(stats) {
    el.total.textContent = stats.total;
    el.video.textContent = stats.videoCount;
    el.comment.textContent = stats.commentCount;

    // 近 7 天：从 buckets 算
    let d7 = 0;
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      d7 += (stats.buckets[key] || 0);
    }
    el.d7.textContent = d7;

    // 已记录 / 配额（跟随限制模式：数量显示条数，大小显示占用；配额 0 = 只显已用）
    const evMode = (currentAdv && currentAdv.eventLimitMode) || 'count';
    const events = stats.events || [];
    const bytesEst = events.length ? JSON.stringify(events).length * 2 : 0;
    const warnPct = (currentAdv && currentAdv.byteWarnPct) || DEFAULTS.byteWarnPct;
    let pct = 0;
    if (evMode === 'size') {
      const limitMB = (currentAdv && currentAdv.maxEventsMB != null) ? currentAdv.maxEventsMB : DEFAULTS.maxEventsMB;
      if (limitMB > 0) {
        const limitBytes = limitMB * 1024 * 1024;
        el.storage.textContent = fmtBytes(bytesEst) + ' / ' + fmtBytes(limitBytes);
        pct = Math.round(bytesEst / limitBytes * 100);
      } else {
        el.storage.textContent = fmtBytes(bytesEst); // 0 = 不限制，只显示已用大小
      }
    } else {
      const quota = (currentAdv && currentAdv.maxEvents != null) ? currentAdv.maxEvents : DEFAULTS.maxEvents;
      if (quota > 0) {
        el.storage.textContent = stats.total + ' / ' + quota;
        pct = Math.round(stats.total / quota * 100);
      } else {
        el.storage.textContent = stats.total; // 0 = 不限制，只显示已用条数
      }
    }
    if (pct >= warnPct) el.storage.style.color = '#ff4d4f';
    else if (pct >= warnPct - 20) el.storage.style.color = '#ffd700';
    else el.storage.style.color = '';

    // 停止记录提示（超额策略②：配额满后不再写入新事件）
    if (stats.quotaStoppedAt) {
      el.hint.textContent = '⛔ 配额已满，已停止记录新数据（超额策略：停止记录）。请推送归档或清理已归档数据后恢复';
    } else if (!archivedView && el.hint.textContent.indexOf('📦 正在查看归档') !== 0) {
      el.hint.textContent = '';
    }
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

  // ---------- Tooltip ----------
  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'stats-tooltip';
    tooltip.style.cssText = 'position:fixed;display:none;background:#2b2b2b;border:1px solid #444;color:#ddd;padding:6px 10px;border-radius:6px;font-size:11px;pointer-events:none;z-index:99;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    document.body.appendChild(tooltip);
    return tooltip;
  }

  // ---------- 主渲染 ----------
  async function render() {
    try {
      // 加载高级设置（表单 + 配额显示）
      await loadAdvSettings();

      let stats = null;
      if (typeof BilibanStorage !== 'undefined' && BilibanStorage.getBlockStats) {
        stats = await BilibanStorage.getBlockStats();
      }
      if (!stats) stats = { total: 0, videoCount: 0, commentCount: 0, events: [], aggregates: {}, buckets: {}, lastSynced: 0 };
      currentStats = stats;
      updateQuotaUsed(stats);

      renderOverview(stats);

      const hasData = stats.total > 0 || Object.keys(stats.buckets || {}).length > 0;
      if (!hasData) {
        el.canvas.style.display = 'none';
        el.empty.style.display = 'block';
        el.hint.textContent = '';
      } else {
        el.canvas.style.display = 'block';
        el.empty.style.display = 'none';
        drawChart(stats);
      }
    } catch (e) {
      el.hint.textContent = '数据面板渲染失败：' + (e.message || e);
    }
    // 归档区渲染（云端分块列表 + 下载记录）
    try { await renderArchiveUI(); } catch (e) { /* 归档区失败不影响主面板 */ }
  }

  let currentAdv = DEFAULTS;

  // 日期格式化
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // 下载归档分块（fetch 带 token → blob → chrome.downloads）
  async function downloadArchivePart(name, dir) {
    if (typeof BilibanBackupSync === 'undefined' || typeof BilibanBackupSync.readDataFile !== 'function') {
      throw new Error('归档模块未加载');
    }
    const part = await BilibanBackupSync.readDataFile(name, dir);
    if (!part) throw new Error('分块读取失败');
    const blob = new Blob([JSON.stringify(part, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const fileName = 'biliban_archive_' + name + '.json';
      let downloadId = null;
      if (typeof chrome.downloads !== 'undefined' && chrome.downloads.download) {
        downloadId = await chrome.downloads.download({ url: url, filename: fileName, saveAs: false });
      } else {
        // 无 downloads 权限时的降级：a 标签下载
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
      }
      await BilibanBackupSync.addDownload({
        id: name + '_' + Date.now(),
        partName: name,
        dir: dir || '',
        fileName: fileName,
        downloadedAt: Date.now(),
        eventCount: (part.meta && part.meta.eventCount) || 0,
        downloadId: downloadId
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  // 渲染归档区（云端分块列表 + 下载记录）
  async function renderArchiveUI() {
    if (!archEl.cloudList) return;
    try {
      if (typeof BilibanBackupSync === 'undefined') {
        archEl.status.textContent = '归档模块未加载';
        archEl.status.style.color = '#ff4d4f';
        return;
      }
      const parts = await BilibanBackupSync.listArchiveParts();
      const downloads = await BilibanBackupSync.getDownloads();
      const downloadedNames = new Set(downloads.map(d => d.partName));
      archEl.summary.textContent = parts.length ? '（云端 ' + parts.length + ' 个分块）' : '';

      if (parts.length === 0) {
        archEl.cloudList.innerHTML = '<div class="archive-tip">暂无云端归档分块（推送数据到云后自动生成）</div>';
      } else {
        archEl.cloudList.innerHTML = parts.slice().reverse().map(p => {
          const m = p.meta || {};
          const tr = m.timeRange ? fmtDate(m.timeRange.from) + ' ~ ' + fmtDate(m.timeRange.to) : '';
          return '<div class="archive-item">' +
            '<span class="archive-meta">' + p.name + '</span>' +
            '<span class="archive-sub">' + (m.eventCount || 0) + ' 事件 · ' + tr + ' · ' + fmtBytes(p.size || 0) + '</span>' +
            (downloadedNames.has(p.name) ? '<span class="archive-sub">✅ 已下载</span>' : '') +
            '<button class="secondary-btn-sm archive-dl-btn" data-name="' + p.name + '" data-dir="' + (p.dir || '') + '">下载</button>' +
            '</div>';
        }).join('');
        archEl.cloudList.querySelectorAll('.archive-dl-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '下载中...';
            try {
              await downloadArchivePart(btn.dataset.name, btn.dataset.dir || undefined);
              archEl.status.textContent = '✅ 已下载 ' + btn.dataset.name;
              archEl.status.style.color = '#7ecb20';
              await renderArchiveUI();
            } catch (e) {
              archEl.status.textContent = '❌ 下载失败: ' + (e.message || e);
              archEl.status.style.color = '#ff4d4f';
              btn.disabled = false;
              btn.textContent = '下载';
            }
          });
        });
      }

      if (downloads.length === 0) {
        archEl.downloadList.innerHTML = '<div class="archive-tip">暂无下载记录</div>';
      } else {
        archEl.downloadList.innerHTML = downloads.slice().reverse().map(d =>
          '<div class="archive-item">' +
          '<span class="archive-meta">' + d.fileName + '</span>' +
          '<span class="archive-sub">' + fmtDate(d.downloadedAt) + ' 下载 · ' + (d.eventCount || 0) + ' 事件</span>' +
          '<button class="secondary-btn-sm archive-load-btn" data-name="' + d.partName + '" data-dir="' + (d.dir || '') + '">加载</button>' +
          '<button class="secondary-btn-sm archive-del-btn" data-id="' + d.id + '">删除</button>' +
          '</div>'
        ).join('');
        // 加载：从云端拉取分块 → 数据面板切换为归档视图
        archEl.downloadList.querySelectorAll('.archive-load-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              btn.disabled = true;
              btn.textContent = '加载中...';
              await loadArchivePart(btn.dataset.name, btn.dataset.dir || undefined);
              archEl.status.textContent = '📦 已加载归档分块 ' + btn.dataset.name;
              archEl.status.style.color = '#7ecb20';
            } catch (e) {
              archEl.status.textContent = '❌ 加载失败: ' + (e.message || e);
              archEl.status.style.color = '#ff4d4f';
            } finally {
              btn.disabled = false;
              btn.textContent = '加载';
            }
          });
        });
        // 删除：删本地文件（云端归档保留）+ 删记录
        archEl.downloadList.querySelectorAll('.archive-del-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              const rec = downloads.find(d => d.id === btn.dataset.id);
              if (rec && rec.downloadId != null && typeof chrome.downloads !== 'undefined' && chrome.downloads.removeFile) {
                try { await chrome.downloads.removeFile(rec.downloadId); } catch (e) { /* 文件可能已手动删除 */ }
              }
              await BilibanBackupSync.removeDownload(btn.dataset.id);
              archEl.status.textContent = '✅ 已删除本地文件与记录（云端分块保留）';
              archEl.status.style.color = '#7ecb20';
              await renderArchiveUI();
            } catch (e) {
              archEl.status.textContent = '❌ 删除失败: ' + (e.message || e);
              archEl.status.style.color = '#ff4d4f';
            }
          });
        });
      }
      archEl.status.textContent = '';
    } catch (e) {
      archEl.status.textContent = '❌ ' + (e.message || e);
      archEl.status.style.color = '#ff4d4f';
    }
  }

  // 加载归档分块 → 数据面板切换为归档视图（概览 + 折线图显示分块历史数据）
  async function loadArchivePart(name, dir) {
    if (typeof BilibanBackupSync === 'undefined' || typeof BilibanBackupSync.readDataFile !== 'function') {
      throw new Error('归档模块未加载');
    }
    const part = await BilibanBackupSync.readDataFile(name, dir);
    if (!part) throw new Error('分块读取失败');
    const events = Array.isArray(part.events) ? part.events : [];
    // 从事件明细重建按天 buckets（折线图数据源）
    const buckets = {}, videoBuckets = {}, commentBuckets = {};
    for (const ev of events) {
      const d = new Date(ev.timestamp || 0);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      buckets[key] = (buckets[key] || 0) + 1;
      if (ev.type === 'video') videoBuckets[key] = (videoBuckets[key] || 0) + 1;
      else commentBuckets[key] = (commentBuckets[key] || 0) + 1;
    }
    archivedStats = {
      total: events.length,
      videoCount: events.filter(e => e.type === 'video').length,
      commentCount: events.filter(e => e.type !== 'video').length,
      events: events,
      aggregates: part.aggregates || {},
      buckets: buckets,
      videoBuckets: videoBuckets,
      commentBuckets: commentBuckets,
      lastSynced: 0
    };
    archivedView = { name: name, dir: dir || '' };
    renderOverview(archivedStats);
    if (archivedStats.total > 0 || Object.keys(buckets).length > 0) {
      el.canvas.style.display = 'block';
      el.empty.style.display = 'none';
      drawChart(archivedStats);
    } else {
      el.canvas.style.display = 'none';
      el.empty.style.display = 'block';
    }
    el.hint.textContent = '📦 正在查看归档分块 ' + name + '（' + events.length + ' 事件，' + Object.keys(buckets).length + ' 天）——点「↩ 返回当前数据」恢复实时数据';
    if (archEl.back) archEl.back.style.display = 'inline-block';
  }

  // 退出归档视图，恢复实时数据
  function exitArchiveView() {
    archivedView = null;
    archivedStats = null;
    if (archEl.back) archEl.back.style.display = 'none';
    render();
  }

  if (archEl.refresh) archEl.refresh.addEventListener('click', renderArchiveUI);
  if (archEl.back) archEl.back.addEventListener('click', exitArchiveView);

  // ---------- 事件 ----------
  if (el.refresh) el.refresh.addEventListener('click', render);
  if (el.granularity) el.granularity.addEventListener('change', () => { if (currentStats) drawChart(currentStats); });
  if (el.range) el.range.addEventListener('change', () => { if (currentStats) drawChart(currentStats); });

  if (el.clear) {
    el.clear.addEventListener('click', async () => {
      if (!confirm('确定清空所有屏蔽统计数据吗？此操作不可恢复。')) return;
      try {
        if (typeof BilibanStorage.clearBlockEvents === 'function') await BilibanStorage.clearBlockEvents();
        el.hint.textContent = '已清空统计数据';
        await render();
      } catch (e) {
        el.hint.textContent = '清空失败：' + (e.message || e);
      }
    });
  }

  // ---------- 高级设置 ----------
  const advEl = {
    batch: document.getElementById('adv-flush-batch'),
    interval: document.getElementById('adv-flush-interval'),
    eventLimitMode: document.getElementById('adv-event-limit-mode'),
    maxEvents: document.getElementById('adv-max-events'),
    maxEventsItem: document.getElementById('adv-max-events-item'),
    maxEventsUsed: document.getElementById('adv-events-used'),
    maxEventsMB: document.getElementById('adv-max-events-mb'),
    maxEventsMBItem: document.getElementById('adv-max-events-mb-item'),
    maxEventsMBUsed: document.getElementById('adv-events-mb-used'),
    overflow: document.getElementById('adv-overflow-strategy'),
    byteWarn: document.getElementById('adv-byte-warn'),
    recordComment: document.getElementById('adv-record-comment'),
    recordVideo: document.getElementById('adv-record-video'),
    save: document.getElementById('adv-save'),
    reset: document.getElementById('adv-reset'),
    hint: document.getElementById('adv-hint'),
    saveData: document.getElementById('adv-save-data'),
    hintData: document.getElementById('adv-hint-data'),
    archiveMergeMB: document.getElementById('adv-archive-merge-mb'),
    archiveCleanPct: document.getElementById('adv-archive-clean-pct'),
    archiveAutoClean: document.getElementById('adv-archive-auto-clean'),
    archiveSave: document.getElementById('adv-archive-save'),
    archiveCleanBtn: document.getElementById('adv-archive-clean-btn'),
    archiveHint: document.getElementById('adv-archive-hint')
  };

  // 限制模式联动：切换时显示对应输入框与已用统计
  function syncLimitModeUI() {
    const em = advEl.eventLimitMode ? advEl.eventLimitMode.value : 'count';
    if (advEl.maxEventsItem) advEl.maxEventsItem.style.display = em === 'count' ? '' : 'none';
    if (advEl.maxEventsMBItem) advEl.maxEventsMBItem.style.display = em === 'size' ? '' : 'none';
  }

  // 格式化字节为可读大小
  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // 更新配额「已使用」显示：数量模式显示条数，大小模式显示估算占用
  function updateQuotaUsed(stats) {
    if (!stats) return;
    const events = stats.events || [];
    const eventsBytes = events.length ? JSON.stringify(events).length * 2 : 0;
    const em = advEl.eventLimitMode ? advEl.eventLimitMode.value : 'count';
    if (em === 'count') {
      if (advEl.maxEventsUsed) advEl.maxEventsUsed.textContent = '已用 ' + events.length + ' 条';
    } else {
      if (advEl.maxEventsMBUsed) advEl.maxEventsMBUsed.textContent = '已用 ' + fmtBytes(eventsBytes);
    }
  }

  function fillAdvForm(cfg) {
    advEl.batch.value = cfg.flushBatch;
    advEl.interval.value = cfg.flushInterval;
    if (advEl.eventLimitMode) advEl.eventLimitMode.value = cfg.eventLimitMode || 'size';
    advEl.maxEvents.value = cfg.maxEvents;
    if (advEl.maxEventsMB) advEl.maxEventsMB.value = cfg.maxEventsMB != null ? cfg.maxEventsMB : DEFAULTS.maxEventsMB;
    advEl.overflow.value = cfg.overflowStrategy;
    advEl.byteWarn.value = cfg.byteWarnPct;
    if (advEl.archiveMergeMB) advEl.archiveMergeMB.value = cfg.archiveMergeMB != null ? cfg.archiveMergeMB : DEFAULTS.archiveMergeMB;
    if (advEl.archiveCleanPct) advEl.archiveCleanPct.value = cfg.archiveCleanPct != null ? cfg.archiveCleanPct : DEFAULTS.archiveCleanPct;
    if (advEl.archiveAutoClean) advEl.archiveAutoClean.checked = !!cfg.archiveAutoClean;
    advEl.recordComment.checked = !!cfg.recordComment;
    advEl.recordVideo.checked = !!cfg.recordVideo;
    syncLimitModeUI();
  }

  function readAdvForm() {
    const evMode = advEl.eventLimitMode ? advEl.eventLimitMode.value : 'count';
    return {
      flushBatch: clampInt(advEl.batch.value, 1, 1000, DEFAULTS.flushBatch),
      flushInterval: clampInt(advEl.interval.value, 1, 300, DEFAULTS.flushInterval),
      eventLimitMode: evMode,
      maxEvents: clampInt(advEl.maxEvents.value, 0, 500000, DEFAULTS.maxEvents),
      maxEventsMB: advEl.maxEventsMB ? clampInt(advEl.maxEventsMB.value, 0, 50, DEFAULTS.maxEventsMB) : DEFAULTS.maxEventsMB,
      overflowStrategy: Number(advEl.overflow.value) || 1,
      maxEventsMB: advEl.maxEventsMB ? clampInt(advEl.maxEventsMB.value, 0, 50, DEFAULTS.maxEventsMB) : DEFAULTS.maxEventsMB,
      overflowStrategy: Number(advEl.overflow.value) || 1,
      byteWarnPct: advEl.byteWarn ? clampInt(advEl.byteWarn.value, 1, 100, DEFAULTS.byteWarnPct) : DEFAULTS.byteWarnPct,
      archiveMergeMB: advEl.archiveMergeMB ? clampInt(advEl.archiveMergeMB.value, 1, 100, DEFAULTS.archiveMergeMB) : DEFAULTS.archiveMergeMB,
      archiveCleanPct: advEl.archiveCleanPct ? clampInt(advEl.archiveCleanPct.value, 0, 100, DEFAULTS.archiveCleanPct) : DEFAULTS.archiveCleanPct,
      archiveAutoClean: advEl.archiveAutoClean ? advEl.archiveAutoClean.checked : DEFAULTS.archiveAutoClean,
      recordComment: advEl.recordComment.checked,
      recordVideo: advEl.recordVideo.checked,
      recordSubtitle: DEFAULTS.recordSubtitle,
      saveVideoTitle: DEFAULTS.saveVideoTitle,
      keepUidDetail: DEFAULTS.keepUidDetail
    };
  }

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }

  async function loadAdvSettings() {
    try {
      if (typeof BilibanStorage.getAdvancedSettings === 'function') {
        const saved = await BilibanStorage.getAdvancedSettings();
        currentAdv = Object.assign({}, DEFAULTS, saved || {});
      } else {
        currentAdv = Object.assign({}, DEFAULTS);
      }
    } catch (e) {
      currentAdv = Object.assign({}, DEFAULTS);
    }
    fillAdvForm(currentAdv);
    return currentAdv;
  }

  async function saveAdvSettings(hintEl) {
    const cfg = readAdvForm();
    try {
      if (typeof BilibanStorage.setAdvancedSettings === 'function') {
        await BilibanStorage.setAdvancedSettings(cfg);
      }
      currentAdv = cfg;
      const h = hintEl || advEl.hint;
      h.textContent = '✅ 已保存，采集端下次刷盘生效';
      h.style.color = '#7ecb20';
    } catch (e) {
      const h = hintEl || advEl.hint;
      h.textContent = '保存失败：' + (e.message || e);
      h.style.color = '#ff4d4f';
    }
  }

  if (advEl.save) advEl.save.addEventListener('click', () => saveAdvSettings());
  if (advEl.saveData) advEl.saveData.addEventListener('click', () => saveAdvSettings(advEl.hintData));
  if (advEl.reset) {
    advEl.reset.addEventListener('click', () => {
      fillAdvForm(DEFAULTS);
      saveAdvSettings();
    });
  }
  if (advEl.eventLimitMode) advEl.eventLimitMode.addEventListener('change', syncLimitModeUI);

  // 归档设置保存按钮（保存完整高级设置表单，含归档字段）
  if (advEl.archiveSave) {
    advEl.archiveSave.addEventListener('click', () => saveAdvSettings(advEl.archiveHint));
  }

  // 手动清理已归档数据（按比例删最旧，0=不删 100=全清）
  if (advEl.archiveCleanBtn) {
    advEl.archiveCleanBtn.addEventListener('click', async () => {
      const pct = advEl.archiveCleanPct ? clampInt(advEl.archiveCleanPct.value, 0, 100, DEFAULTS.archiveCleanPct) : DEFAULTS.archiveCleanPct;
      if (pct <= 0) { advEl.archiveHint.textContent = '清理比例需 > 0'; advEl.archiveHint.style.color = '#ffd700'; return; }
      if (!confirm('确定清理已归档数据中最旧的 ' + pct + '% 吗？\n仅删除本地已归档的旧数据（云端分块副本保留），未归档数据与曲线数据不受影响。')) return;
      if (typeof BilibanBackupSync === 'undefined' || typeof BilibanBackupSync.manualCleanArchived !== 'function') {
        advEl.archiveHint.textContent = '归档模块未加载'; advEl.archiveHint.style.color = '#ff4d4f'; return;
      }
      try {
        const r = await BilibanBackupSync.manualCleanArchived(pct);
        advEl.archiveHint.textContent = '✅ ' + (r.message || ('清理 ' + (r.cleaned || 0) + ' 条'));
        advEl.archiveHint.style.color = '#7ecb20';
      } catch (e) {
        advEl.archiveHint.textContent = '❌ 清理失败: ' + (e.message || e);
        advEl.archiveHint.style.color = '#ff4d4f';
      }
    });
  }

  // ---------- 备份仓库设置 ----------
  const bkEl = {
    repoName: document.getElementById('bk-repo-name'),
    sameRepo: document.getElementById('bk-same-repo'),
    dataRepo: document.getElementById('bk-data-repo'),
    save: document.getElementById('bk-save'),
    hint: document.getElementById('bk-hint')
  };

  async function loadBackupSettings() {
    try {
      if (typeof BilibanBackupSync === 'undefined') return;
      const s = await BilibanBackupSync.getSettings();
      bkEl.repoName.value = s.repoName;
      bkEl.sameRepo.checked = !!s.sameRepo;
      bkEl.dataRepo.value = s.dataRepoName;
      bkEl.dataRepo.disabled = !!s.sameRepo;
    } catch (e) { /* 忽略 */ }
  }

  async function saveBackupSettings() {
    if (typeof BilibanBackupSync === 'undefined') {
      bkEl.hint.textContent = '备份模块未加载';
      bkEl.hint.style.color = '#ff4d4f';
      return;
    }
    try {
      await BilibanBackupSync.setSettings({
        repoName: bkEl.repoName.value.trim() || 'BILI-Blacklist',
        sameRepo: bkEl.sameRepo.checked,
        dataRepoName: bkEl.dataRepo.value.trim() || 'BILI-Blacklist-Data'
      });
      bkEl.hint.textContent = '✅ 备份仓库设置已保存';
      bkEl.hint.style.color = '#7ecb20';
    } catch (e) {
      bkEl.hint.textContent = '保存失败：' + (e.message || e);
      bkEl.hint.style.color = '#ff4d4f';
    }
  }

  if (bkEl.save) bkEl.save.addEventListener('click', saveBackupSettings);
  if (bkEl.sameRepo) {
    bkEl.sameRepo.addEventListener('change', () => {
      bkEl.dataRepo.disabled = bkEl.sameRepo.checked;
      // 同仓库时隐藏「数据仓库可见性」选择（同一仓库则可见性跟随黑名单仓库）
      const visItem = document.getElementById('gh-data-vis-item');
      if (visItem) visItem.style.display = bkEl.sameRepo.checked ? 'none' : '';
    });
  }

  // ---------- GitHub 账户设置 ----------
  const ghEl = {
    tokenInput: document.getElementById('gh-token-input'),
    visibility: document.getElementById('gh-visibility'),
    dataVisibility: document.getElementById('gh-data-visibility'),
    save: document.getElementById('gh-token-save'),
    status: document.getElementById('gh-account-status')
  };

  async function loadGithubAccount() {
    try {
      if (typeof BilibanGithubSync === 'undefined') return;
      const token = await BilibanGithubSync.getToken();
      if (token) ghEl.tokenInput.value = token;
      const isPrivate = await BilibanGithubSync.getRepoVisibilityPref();
      ghEl.visibility.value = isPrivate ? 'private' : 'public';
      // 数据仓库可见性
      if (typeof BilibanBackupSync !== 'undefined' && typeof BilibanBackupSync.getDataRepoVisibilityPref === 'function') {
        const dataPriv = await BilibanBackupSync.getDataRepoVisibilityPref();
        ghEl.dataVisibility.value = dataPriv ? 'private' : 'public';
      }
      // 同仓库时隐藏数据可见性
      const visItem = document.getElementById('gh-data-vis-item');
      if (bkEl.sameRepo && visItem) visItem.style.display = bkEl.sameRepo.checked ? 'none' : '';
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
        if (typeof BilibanBackupSync !== 'undefined' && typeof BilibanBackupSync.setDataRepoVisibilityPref === 'function') {
          await BilibanBackupSync.setDataRepoVisibilityPref(ghEl.dataVisibility.value === 'private');
        }
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
  if (ghEl.dataVisibility) {
    ghEl.dataVisibility.addEventListener('change', async () => {
      try {
        if (typeof BilibanBackupSync !== 'undefined' && typeof BilibanBackupSync.setDataRepoVisibilityPref === 'function') {
          await BilibanBackupSync.setDataRepoVisibilityPref(ghEl.dataVisibility.value === 'private');
        }
      } catch (e) { /* 忽略 */ }
    });
  }

  // ---------- 对外接口 ----------
  window.__BILIBAN_STATS_UI__ = {
    render: render,
    loadAdvSettings: loadAdvSettings,
    loadBackupSettings: loadBackupSettings,
    loadGithubAccount: loadGithubAccount
  };
})();
