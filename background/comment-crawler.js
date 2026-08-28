/**
 * BILIBAN 评论爬取模块 (Service Worker)
 *
 * 职责：
 *  - 解析 bvid/aid/视频 URL，通过 x/web-interface/view 获取 aid
 *  - 调用 x/v2/reply/main 分页拉取一级评论；可选展开楼中楼 (x/v2/reply/reply)
 *  - 请求节流（分页间随机延时）+ 最大页数上限，风控码识别（-412/-352/-403）
 *  - 复用浏览器对 api.bilibili.com 的登录态（credentials: 'include' 自动携带 cookie）
 *  - 对评论用户批量匹配本地黑名单，标记命中用户及其所在分组
 *  - 状态经 chrome.storage.session 持久化，并通过 runtime 消息实时推送给管理页
 *
 * 消息协议：
 *  - { type: 'BILIBAN_SCAN_START', videoRef, options }  -> 开始扫描
 *  - { type: 'BILIBAN_SCAN_STOP' }                       -> 请求停止
 *  - { type: 'BILIBAN_SCAN_STATUS' }                     -> 查询当前状态
 *  推送: { type: 'BILIBAN_SCAN_UPDATE', state }
 */

'use strict';

// ==================== MD5 (纯 JS, 用于 WBI 签名) ====================

const MD5 = (function() {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];

  function toUtf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); continue; }
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 < 0xe000) {
          i++;
          const v = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
          out.push(0xf0 | (v >> 18), 0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f));
          continue;
        }
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function md5(inputString) {
    const bytes = toUtf8Bytes(inputString);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) % 256);

    let A = 0x67452301, B = 0xefcdab89, C = 0x98badcfe, D = 0x10325476;
    const x = new Array(16);

    function rotl(v, s) { return (v << s) | (v >>> (32 - s)); }

    for (let i = 0; i < bytes.length; i += 64) {
      for (let j = 0; j < 16; j++) {
        const o = i + j * 4;
        x[j] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
      }
      let a = A, b = B, c = C, d = D;
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) { f = (b & c) | (~b & d); g = j; }
        else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * j) % 16; }
        f = (f + a + K[j] + x[g]) | 0;
        a = d; d = c; c = b;
        b = (b + rotl(f, S[j])) | 0;
      }
      A = (A + a) | 0; B = (B + b) | 0; C = (C + c) | 0; D = (D + d) | 0;
    }

    function toHex(num) {
      let hex = '';
      for (let i = 0; i < 4; i++) {
        hex += ((num >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      }
      return hex;
    }
    return (toHex(A) + toHex(B) + toHex(C) + toHex(D)).toLowerCase();
  }

  return md5;
})();

// ==================== 工具 ====================

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randBetween(a, b) { return a + Math.random() * (b - a); }
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function cleanText(text, maxLen = 80, keepBreaks = false) {
  if (!text) return '';
  let s = String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  if (!keepBreaks) s = s.replace(/\s+/g, ' ');
  return s.trim().slice(0, maxLen);
}

// ==================== WBI 签名 ====================

const WBI_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

let wbiCache = { mixinKey: null, fetchedAt: 0 };

function getKeyFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/\/([0-9a-zA-Z]+)\.(?:png|jpg|jpeg|webp)/);
  return m ? m[1] : '';
}

async function getMixinKey() {
  const now = Date.now();
  if (wbiCache.mixinKey && now - wbiCache.fetchedAt < 3600 * 1000) {
    return wbiCache.mixinKey;
  }
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'include',
    headers: { 'Referer': 'https://www.bilibili.com/' }
  });
  if (!res.ok) throw new Error('获取 WBI 密钥失败 (HTTP ' + res.status + ')');
  const data = await res.json();
  if (data.code !== 0 || !data.data || !data.data.wbi_img) {
    throw new Error('获取 WBI 密钥失败 (code=' + data.code + ')');
  }
  const imgKey = getKeyFromUrl(data.data.wbi_img.img_url);
  const subKey = getKeyFromUrl(data.data.wbi_img.sub_url);
  if (!imgKey || !subKey) throw new Error('WBI 密钥解析失败');
  const mixed = imgKey + subKey;
  let mixin = '';
  for (let i = 0; i < 32; i++) mixin += mixed[WBI_TAB[i]];
  wbiCache = { mixinKey: mixin, fetchedAt: now };
  return mixin;
}

/**
 * 生成带 wts/w_rid 的签名参数
 * @param {Object} params 普通参数
 * @returns {Object} 含 wts 与 w_rid 的完整参数
 */
async function signParams(params) {
  const mixinKey = await getMixinKey();
  const signed = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
  const sortedKeys = Object.keys(signed).sort();
  const query = sortedKeys
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(signed[k])))
    .join('&');
  const wRid = MD5(query + mixinKey);
  signed.w_rid = wRid;
  return signed;
}

function buildQuery(params) {
  return Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&');
}

// ==================== 状态管理 ====================

const STATE_KEY = 'biliban_scan';
const MAX_RESULTS = 3000;          // 去重后的用户上限，防止撑爆 session storage
const MAX_THREADS = 600;           // 评论线程（主楼）展示上限；0 页全量扫描时也受此保护
const MAX_REPLIES_PER_THREAD = 15; // 单个主楼最多展示的回复条数

const Crawler = {
  running: false,
  stopRequested: false,
  _mainWbiOk: null, // 是否已确认主接口走 wbi
  _subWbiOk: null,

  async loadState() {
    const result = await chrome.storage.session.get(STATE_KEY);
    return result[STATE_KEY] || null;
  },

  async saveState(patch) {
    const state = (await this.loadState()) || {};
    // 合并 patch 到顶层，结果列表单独字段
    Object.keys(patch).forEach(k => { state[k] = patch[k]; });
    await chrome.storage.session.set({ [STATE_KEY]: state });
    this.notify(state);
  },

  notify(state) {
    chrome.runtime.sendMessage({ type: 'BILIBAN_SCAN_UPDATE', state: state || null })
      .catch(() => {});
  },

  async getStatus() {
    return await this.loadState();
  },

  async resetState() {
    await chrome.storage.session.remove(STATE_KEY);
    this.notify(null);
  },

  // 后台被唤醒时，若上次扫描标记为 running 说明被 SW 休眠中断
  async recoverInterrupted() {
    const state = await this.loadState();
    if (state && state.status === 'running') {
      state.status = 'stopped';
      state.endedAt = Date.now();
      state.note = '扫描被中断（后台休眠），已停止，可重新开始';
      await chrome.storage.session.set({ [STATE_KEY]: state });
      this.notify(state);
    }
  },

  // ==================== 视频解析 ====================

  parseVideoRef(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^BV[0-9A-Za-z]{8,}$/.test(raw)) return { bvid: raw };
    const av = raw.match(/^av(\d+)$/i);
    if (av) return { aid: parseInt(av[1], 10) };
    if (/^\d{6,}$/.test(raw)) return { aid: parseInt(raw, 10) };
    try {
      const url = new URL(raw);
      if (url.hostname.includes('bilibili.com')) {
        const bv = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (bv) return { bvid: bv[1] };
        const avNum = url.pathname.match(/\/video\/av(\d+)/i);
        if (avNum) return { aid: parseInt(avNum[1], 10) };
      }
    } catch (e) { /* 不是 URL */ }
    return null;
  },

  async resolveVideo(ref) {
    const params = ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid };
    const query = buildQuery(params);
    const res = await fetch('https://api.bilibili.com/x/web-interface/view?' + query, {
      credentials: 'include',
      headers: { 'Referer': 'https://www.bilibili.com/' }
    });
    if (!res.ok) throw new Error('视频信息获取失败 (HTTP ' + res.status + ')');
    const data = await res.json();
    if (data.code !== 0) {
      if (data.code === -404) throw new Error('视频不存在或已删除');
      throw new Error('视频信息获取失败 (code=' + data.code + ')');
    }
    const v = data.data;
    return {
      aid: parseInt(v.aid, 10),
      bvid: v.bvid || ref.bvid,
      title: v.title || '',
      ownerName: (v.owner && v.owner.name) || '',
      ownerMid: (v.owner && v.owner.mid) || 0,
      pic: v.pic || '',
      url: 'https://www.bilibili.com/video/' + (v.bvid || ref.bvid)
    };
  },

  // ==================== API 请求 ====================

  async apiGet(base, endpoint, params, useWbi) {
    let url;
    if (useWbi) {
      const signed = await signParams(params);
      url = base + '/wbi/' + endpoint + '?' + buildQuery(signed);
    } else {
      url = base + '/' + endpoint + '?' + buildQuery(params);
    }
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Referer': 'https://www.bilibili.com/' }
    });
    if (!res.ok) {
      if (res.status === 412) throw Object.assign(new Error('触发风控 (HTTP 412)，请稍后再试'), { risk: true });
      throw new Error('请求失败 (HTTP ' + res.status + ')');
    }
    const data = await res.json();
    if (data.code === -412) {
      throw Object.assign(new Error('触发风控 (code=-412)，请求过频或需验证，请放慢节奏'), { risk: true });
    }
    return data;
  },

  /**
   * 拉取一级评论一页。wbi 失败 (code -352/-403) 时自动降级为无签名接口。
   * @returns {{ replies: Array, next: number|null, isEnd: boolean }}
   */
  async fetchMainPage(oid, mode, next) {
    if (this._mainWbiOk === false) {
      return this._fetchMainPlain(oid, mode, next);
    }
    try {
      const params = { type: 1, oid: oid, mode: mode, ps: 20 };
      if (next != null) params.next = next;
      const data = await this.apiGet('https://api.bilibili.com/x/v2/reply', 'main', params, true);
      if (data.code === 0) {
        this._mainWbiOk = true;
        return this._parseMainData(data.data);
      }
      if (data.code === -352 || data.code === -403) {
        // wbi 签名不被接受，降级
        this._mainWbiOk = false;
        return this._fetchMainPlain(oid, mode, next);
      }
      throw new Error('评论接口返回异常 (code=' + data.code + ')');
    } catch (e) {
      if (e && e.risk) throw e;
      // 网络/未知错误：重试一次无签名
      this._mainWbiOk = false;
      return this._fetchMainPlain(oid, mode, next);
    }
  },

  async _fetchMainPlain(oid, mode, next) {
    const params = { type: 1, oid: oid, mode: mode, ps: 20 };
    if (next != null) params.next = next;
    const data = await this.apiGet('https://api.bilibili.com/x/v2/reply', 'main', params, false);
    if (data.code !== 0) {
      throw new Error('评论接口返回异常 (code=' + data.code + ')');
    }
    return this._parseMainData(data.data);
  },

  _parseMainData(d) {
    const replies = (d && d.replies) || [];
    let next = null;
    let isEnd = true;
    if (d && d.cursor) {
      next = d.cursor.next != null ? d.cursor.next : null;
      isEnd = !!d.cursor.is_end;
    } else if (d && d.pagination) {
      next = d.pagination.next_offset != null ? d.pagination.next_offset : null;
      isEnd = !!d.pagination.is_end;
    }
    return { replies, next, isEnd };
  },

  /**
   * 展开某个一级评论的楼中楼（分页受限）
   * @returns {Promise<Array>} 二级回复数组
   */
  async fetchSubReplies(oid, rootRpid) {
    const collect = [];
    const MAX_SUB_PAGES = 3;
    for (let pn = 1; pn <= MAX_SUB_PAGES; pn++) {
      let data;
      if (this._subWbiOk !== false) {
        try {
          data = await this.apiGet(
            'https://api.bilibili.com/x/v2/reply', 'reply',
            { type: 1, oid: oid, root: rootRpid, ps: 20, pn: pn }, true
          );
          if (data.code === -352 || data.code === -403) {
            this._subWbiOk = false;
            data = await this.apiGet(
              'https://api.bilibili.com/x/v2/reply', 'reply',
              { type: 1, oid: oid, root: rootRpid, ps: 20, pn: pn }, false
            );
          }
          this._subWbiOk = true;
        } catch (e) {
          if (e && e.risk) throw e;
          this._subWbiOk = false;
          data = await this.apiGet(
            'https://api.bilibili.com/x/v2/reply', 'reply',
            { type: 1, oid: oid, root: rootRpid, ps: 20, pn: pn }, false
          );
        }
      } else {
        data = await this.apiGet(
          'https://api.bilibili.com/x/v2/reply', 'reply',
          { type: 1, oid: oid, root: rootRpid, ps: 20, pn: pn }, false
        );
      }
      if (data.code !== 0) {
        throw new Error('楼中楼接口返回异常 (code=' + data.code + ')');
      }
      const batch = (data.data && data.data.replies) || [];
      collect.push(...batch);
      if (batch.length < 20) break;
      await sleep(randBetween(400, 900));
    }
    return collect;
  },

  // ==================== 黑名单匹配 ====================

  async loadBlacklistMap() {
    const result = await chrome.storage.local.get('biliban_blacklist');
    const data = result.biliban_blacklist || { groups: [] };
    const map = new Map(); // uid -> Set<groupName>
    for (const group of data.groups || []) {
      for (const uid of group.uids || []) {
        const uidNum = Number(uid);
        if (isNaN(uidNum)) continue;
        if (!map.has(uidNum)) map.set(uidNum, new Set());
        map.get(uidNum).add(group.name);
      }
    }
    return map;
  },

  addCommentUser(users, reply, blacklistMap) {
    const member = (reply && reply.member) || {};
    const uid = Number(member.mid || reply.mid);
    if (!uid || isNaN(uid)) return;
    let u = users.get(uid);
    const snippet = cleanText(reply.content && reply.content.message);
    if (!u) {
      if (users.size >= MAX_RESULTS) return;
      u = {
        uid: uid,
        uname: member.uname || '',
        avatar: member.avatar || '',
        sample: snippet,
        commentCount: 0,
        ctime: reply.ctime || 0,
        matched: false,
        groups: []
      };
      users.set(uid, u);
    }
    u.commentCount++;
    if ((reply.ctime || 0) > u.ctime) {
      u.ctime = reply.ctime;
      if (snippet) u.sample = snippet;
    }
    const gs = blacklistMap.get(uid);
    if (gs && gs.size > 0) {
      u.matched = true;
      gs.forEach(g => { if (!u.groups.includes(g)) u.groups.push(g); });
    }
  },

  /**
   * 将一个主评论加入线程列表（threads），用于管理页复原评论区展示
   * 接口随主列表免费附带的内嵌楼中楼（<=3 条）会一并写入
   */
  addThread(threads, threadIndex, reply) {
    if (threads.length >= MAX_THREADS) return;
    const member = (reply && reply.member) || {};
    const uid = Number(member.mid || reply.mid);
    const rpid = Number(reply && reply.rpid);
    if (!rpid || !uid || isNaN(uid)) return;

    const thread = {
      rpid: rpid,
      uid: uid,
      uname: member.uname || '',
      avatar: member.avatar || '',
      content: cleanText(reply.content && reply.content.message, 200, true),
      ctime: reply.ctime || 0,
      replies: []
    };
    const embedded = (reply.replies || []);
    for (const sub of embedded) {
      this.addThreadReply(thread, sub);
    }
    threads.push(thread);
    threadIndex.set(rpid, thread);
  },

  /**
   * 把一个楼中楼回复挂到所属主楼线程下（缩进展示用）
   */
  addThreadReply(rootThread, sub) {
    if (!rootThread || !sub) return;
    if (rootThread.replies.length >= MAX_REPLIES_PER_THREAD) return;
    const member = (sub && sub.member) || {};
    const uid = Number(member.mid || sub.mid);
    if (!uid || isNaN(uid)) return;
    rootThread.replies.push({
      rpid: Number(sub.rpid) || 0,
      uid: uid,
      uname: member.uname || '',
      content: cleanText(sub.content && sub.content.message, 200, true),
      ctime: sub.ctime || 0
    });
  },

  // ==================== 扫描主流程 ====================

  async startScan(videoRef, options) {
    if (this.running) {
      return { ok: false, error: '已有扫描正在进行，请先停止' };
    }
    this.running = true;
    this.stopRequested = false;
    this._mainWbiOk = null;
    this._subWbiOk = null;

    const opt = {
      // maxPages = 0 表示不限制页数，一直拉到评论区末尾（is_end）
      maxPages: clampInt(options && options.maxPages, 0, 500, 10),
      includeSub: !!(options && options.includeSub),
      mode: (options && Number(options.mode) === 2) ? 2 : 3,
      delayMin: clampInt(options && options.delayMin, 300, 6000, 800),
      delayMax: clampInt(options && options.delayMax, 300, 10000, 1500)
    };
    if (opt.delayMax < opt.delayMin) { const t = opt.delayMax; opt.delayMax = opt.delayMin; opt.delayMin = t; }

    const state = {
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      maxPages: opt.maxPages,        // 0 表示全量
      includeSub: opt.includeSub,
      mode: opt.mode,
      timeRangeText: null,           // 如 "最近 1 天"（最新模式时间范围）
      video: null,
      progress: { pages: 0, comments: 0, next: null, isEnd: false },
      results: [],                  // 按用户去重聚合（批量操作）
      threads: [],                  // 评论线程（评论区复原展示，含楼中楼）
      matchedCount: 0,
      truncated: false,
      error: null,
      note: null
    };

    // 时间范围过滤（仅最新模式）：cutoff 之前的评论视为超出范围
    // 最新排序逐页变早，一旦某页整体早于 cutoff 即停止拉取
    let cutoff = null;
    if (opt.mode === 2 && options && options.maxAgeSeconds) {
      const maxAge = clampInt(options.maxAgeSeconds, 1, 15 * 365 * 86400, 86400);
      cutoff = Math.floor(Date.now() / 1000) - maxAge;
      if (options.timeRangeText) {
        state.timeRangeText = options.timeRangeText;
        state.note = '按时间范围拉取：' + options.timeRangeText;
      }
    }
    await chrome.storage.session.set({ [STATE_KEY]: state });
    this.notify(state);

    try {
      const ref = typeof videoRef === 'string' ? this.parseVideoRef(videoRef) : videoRef;
      if (!ref) {
        throw new Error('无法识别视频地址，请输入 bvid（BV 开头）、av 号或完整视频链接');
      }
      const video = await this.resolveVideo(ref);
      state.video = video;
      await chrome.storage.session.set({ [STATE_KEY]: state });
      this.notify(state);

      const users = new Map();
      const threadIndex = new Map(); // rpid -> thread，用于把展开的楼中楼挂回主楼
      const blacklistMap = await this.loadBlacklistMap();
      let next = null;
      let pagesFetched = 0;
      let lastSnippet = null;

      while (!this.stopRequested && (opt.maxPages === 0 || pagesFetched < opt.maxPages)) {
        const page = await this.fetchMainPage(video.aid, opt.mode, next);

        // 时间范围过滤：该页整体早于 cutoff 即算超出范围（最新排序逐页变早），停止
        let hitTimeLimit = false;
        if (cutoff) {
          const before = page.replies.length;
          if (before > 0) {
            page.replies = page.replies.filter(r => (r.ctime || 0) >= cutoff);
            if (page.replies.length === 0) hitTimeLimit = true;
          }
        }

        for (const reply of page.replies) {
          this.addCommentUser(users, reply, blacklistMap);
          this.addThread(state.threads, threadIndex, reply);
        }

        // 可选：展开楼中楼（内嵌的 <=3 条已随主列表写入线程，此处补全剩余回复）
        if (opt.includeSub && page.replies.length > 0) {
          for (const reply of page.replies) {
            if (this.stopRequested) break;
            const embedded = (reply.replies && reply.replies.length) || 0;
            const need = (reply.rcount || embedded) - embedded;
            if (need <= 0) continue;
            const rootThread = threadIndex.get(Number(reply.rpid));
            try {
              const subs = await this.fetchSubReplies(video.aid, reply.rpid);
              for (const sub of subs) {
                this.addCommentUser(users, sub, blacklistMap);
                if (rootThread) this.addThreadReply(rootThread, sub);
              }
            } catch (e) {
              if (e && e.risk) throw e; // 风控立即终止
              lastSnippet = '楼中楼展开失败: ' + e.message;
              break; // 单个根评论失败不中断整页
            }
          }
        }

        pagesFetched++;
        next = page.next;
        state.progress = {
          pages: pagesFetched,
          comments: state.progress.comments + page.replies.length,
          next: next,
          isEnd: page.isEnd
        };
        state.results = Array.from(users.values());
        state.matchedCount = state.results.filter(u => u.matched).length;
        state.truncated = users.size >= MAX_RESULTS || state.threads.length >= MAX_THREADS;
        if (lastSnippet) { state.note = lastSnippet; lastSnippet = null; }

        // 每页持久化一次：既作为进度保存，也通过 storage API 调用维持 SW 存活
        await chrome.storage.session.set({ [STATE_KEY]: state });
        this.notify(state);

        // 时间范围边界：整页已早于 cutoff，无需再翻下一页
        if (hitTimeLimit) {
          state.note = '已达时间范围边界（' + (state.timeRangeText || '设置范围') + '之前），更早的评论已跳过；完成';
          break;
        }

        if (page.isEnd || (next == null && page.replies.length === 0)) break;
        if (next == null && page.replies.length > 0) {
          // 服务端未返回游标但仍有数据，防御性停止
          state.note = '评论区未返回下一页游标，提前停止';
          break;
        }
        if (this.stopRequested) break;

        await sleep(randBetween(opt.delayMin, opt.delayMax));
        // 每页刷新黑名单，及时反映扫描期间的修改
        const fresh = await this.loadBlacklistMap();
        if (fresh.size > 0 || blacklistMap.size === 0) {
          // 全量重算 matched
          state.results.forEach(u => {
            const gs = fresh.get(u.uid);
            u.matched = !!(gs && gs.size > 0);
            u.groups = gs ? Array.from(gs) : [];
          });
          state.matchedCount = state.results.filter(u => u.matched).length;
        }
      }

      const stoppedByUser = this.stopRequested;
      state.status = stoppedByUser ? 'stopped' : 'done';
      state.endedAt = Date.now();
      if (stoppedByUser) state.note = '已手动停止';
      await chrome.storage.session.set({ [STATE_KEY]: state });
      this.notify(state);
      return { ok: true, status: state.status };
    } catch (e) {
      state.status = 'error';
      state.endedAt = Date.now();
      state.error = e && e.message ? e.message : String(e);
      await chrome.storage.session.set({ [STATE_KEY]: state });
      this.notify(state);
      return { ok: false, error: state.error };
    } finally {
      this.running = false;
    }
  },

  async stopScan() {
    this.stopRequested = true;
    return { ok: true };
  }
};

// SW 被唤醒时恢复中断状态
Crawler.recoverInterrupted();

// 导出到 service worker 全局作用域
if (typeof globalThis !== 'undefined') {
  globalThis.BilibanCrawler = Crawler;
}