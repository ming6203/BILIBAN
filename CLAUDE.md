# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 项目概述

BILIBAN 是一个 Chrome 扩展（Manifest V3），用于屏蔽 B 站指定用户。按 UID 过滤评论、视频推荐、搜索结果和直播弹幕。无构建系统或转译步骤——纯原生 JS，由 Chrome 直接加载。

## 开发方式

- **安装**：chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序 → 选择仓库根目录
- **无需构建**：直接编辑 JS/CSS/HTML 文件，然后在 chrome://extensions/ 中点击扩展的刷新按钮
- **未配置测试或代码检查工具**；可用 `node --check <file>` 做语法检查

## 架构

### 页面结构（MV3）

1. **Popup**（`popup/popup.html`）：轻量面板，打开即是云同步界面——GitHub 备份/恢复、分块推送拉取、社区订阅拉取、本地导入导出，以及「打开完整管理面板」入口（`chrome.runtime.openOptionsPage()`）。分组/分块管理等重逻辑已迁出。

2. **管理面板**（`manage/manage.html`，`options_ui` 打开）：承载重逻辑功能——黑名单分组/分块管理（拖拽排序、组内快速添加 UID、分块编辑/删除）、评论扫描入口、匹配结果确认与批量操作。

### 脚本执行上下文

扩展在 bilibili.com 上运行于两个隔离的 JavaScript 世界中：

1. **MAIN world**（`content/interceptor.js`，`run_at: document_start`）：对 `window.fetch` 和 `XMLHttpRequest` 进行猴子补丁，在页面渲染前过滤 API 响应。运行在页面的 JS 上下文中，因此可以拦截网络请求。通过 `window.postMessage` 从内容脚本接收 UID 更新。

2. **Isolated world**（`content/bilibili.js` + `lib/storage.js` + `lib/github.js`，`run_at: document_idle`）：可访问 `chrome.storage` API。处理 DOM 操作——扫描评论/视频卡片、注入屏蔽按钮、移除被屏蔽内容。通过 `postMessage({ type: 'BILIBAN_UPDATE_UIDS' })` 将 UID 变更通知给 MAIN world 拦截器。

3. **Background**（`background/service-worker.js` + `background/comment-crawler.js`，经 `importScripts` 引入）：
   - 监听 `chrome.storage` 变更，向所有 bilibili.com 标签页广播 `{ type: 'refresh' }` 消息
   - 评论扫描调度中枢：接收管理页指令（`BILIBAN_SCAN_START/STOP/STATUS/RESET`），在后台分页拉取评论区、执行黑名单匹配，将进度/结果实时推送给管理页

### 数据流向

```
Popup / 管理页 ──写入──▶ chrome.storage.local
                              │
                   service-worker.js 检测变更
                              │
                   向所有标签页广播 { type: 'refresh' }
                              │
              bilibili.js refreshAll() 重新扫描 DOM
              interceptor.js 从 storage 重新加载 UID

管理页 ──runtime 消息──▶ service-worker.js (BilibanCrawler.startScan)
                              │  fetch api.bilibili.com（credentials: include 复用登录态）
                              │  chrome.storage.session 写入 biliban_scan
                              ▼
              管理页 ←──runtime 消息推送 BILIBAN_SCAN_UPDATE / storage.onChanged
```

### 存储结构（`chrome.storage.local`）

- `biliban_blacklist`：`{ groups: [{ id, name, enabled, uids: number[] }] }`
- `biliban_sources`：`[{ id, owner, repo, path, branch, name }]` — 社区订阅仓库
- `biliban_github_token` / `biliban_gist_id` — GitHub Gist 同步凭证

### 评论扫描状态（`chrome.storage.session`）

- `biliban_scan`：`{ status, video, options, progress, results: [{ uid, uname, avatar, sample, commentCount, ctime, matched, groups }], threads: [{ rpid, uid, uname, avatar, content, ctime, replies: [{ rpid, uid, uname, content, ctime }] }], matchedCount, error, note }`
- `status` 取值：`running | done | stopped | error`；SW 被休眠唤醒时若发现残留 `running` 状态会自动标记为 `stopped`（`Crawler.recoverInterrupted()`）
- `results` 按 UID 去重（上限 3000 位用户），供批量操作；`threads` 按评论线程保存（上限 600 条主楼、每楼最多 15 条回复），供管理页"评论区复原"视图展示
- `maxPages = 0` 表示全量模式：不限页数，持续拉取直到接口返回 `is_end`（上限 500 页防御性保护）

### 评论扫描模块要点

- **接口**：`GET /x/web-interface/view?bvid=` 解析 aid；`/x/v2/reply/main`（wbi 版 `/wbi/main`）分页拉一级评论（`mode=3` 热门 / `mode=2` 最新，游标 `cursor.next`）；可选展开楼中楼 `/x/v2/reply/reply`（每根评论最多 3 页，扫描级子请求预算由 `maxPages` 决定）
- **时间范围**（仅 `mode=2` 最新）：`options.maxAgeSeconds`（如 1d=86400s）→ cutoff = now - maxAge；每页按 `ctime >= cutoff` 过滤，最新排序逐页变早，整页越界即停止（`hitTimeLimit`，note 注明边界）；热门模式不启用
- **WBI 签名**：`comment-crawler.js` 内置纯 JS MD5（自验证过标准向量），通过 `/x/web-interface/nav` 获取 img_key/sub_key 后每 1 小时缓存 mixinKey；签名失败（code -352/-403）自动降级为无签名接口
- **节流/风控**：分页间随机延时（默认 800–1500ms，可配置），最大页数上限（默认 10，上限 50）；HTTP 412 / code -412 立即终止并给出风控提示
- **登录态复用**：所有请求 `credentials: 'include'` 携带浏览器 cookie；依赖 `host_permissions: ["https://api.bilibili.com/*", "*://*.bilibili.com/*"]`

### Shadow DOM 处理

Bilibili 使用带有 Shadow DOM 的 Web Components（`bili-comments`、`bili-comment-thread-renderer` 等）。内容脚本遍历多层 shadow root 以提取 UID 和注入屏蔽按钮。DOM 元素上的 `DONE` 标记（`__biban_done`）用于防止重复处理。

BewlyBewly 兼容性：`getBewlyShadowRoot()` 通过多种选择器策略（包括暴力扫描）定位 BewlyBewly 的 shadow host。其卡片在 `processBewlyCards()` 中单独处理。

### 关键模式

- `BilibanStorage`（`lib/storage.js`）是唯一的数据访问层——所有增删改查都通过它进行
- `bilibili.js` 中的 `CARD_SELECTORS` 是逗号分隔的选择器列表，覆盖不同 Bilibili 布局和扩展的所有已知视频卡片 CSS 选择器
- `extractCardUid()` 尝试多种策略（href 解析、data 属性）从卡片元素中获取 UP 主 UID
- 选组弹窗（`showGroupPicker`）以 fixed 定位的 div 注入，点击外部自动关闭
- 批量加入黑名单使用 `BilibanStorage.addUidsToGroup(groupId, uids)`（单次读写去重）

## 核心文件

- `background/comment-crawler.js` — 评论爬取引擎（WBI 签名、分页、节流、匹配、状态机）
- `background/service-worker.js` — 存储变更广播 + 扫描消息路由
- `content/interceptor.js` — API 层过滤（fetch/XHR 猴子补丁）
- `content/bilibili.js` — DOM 层过滤、按钮注入、Shadow DOM 遍历、BewlyBewly/Gate 兼容
- `lib/storage.js` — 所有数据操作（分组、UID、订阅源、导入导出、合并、批量添加）
- `lib/github.js` — GitHub Gist 同步和 token 管理
- `popup/popup.js` — 轻量弹窗 UI（云同步、订阅、导入导出）
- `manage/manage.js` + `manage/manage.html` + `manage/manage.css` — 完整管理面板（分组/分块管理 + 评论扫描）
- `manifest.json` — 扩展清单（MV3、options_ui、权限、content script 注入配置）