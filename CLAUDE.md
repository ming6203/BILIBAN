# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 项目概述

BILIBAN 是一个 Chrome 扩展（Manifest V3），用于屏蔽 B 站指定用户。按 UID 过滤评论、视频推荐、搜索结果和直播弹幕。无构建系统或转译步骤——纯原生 JS，由 Chrome 直接加载。

## 开发方式

- **安装**：chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序 → 选择仓库根目录
- **无需构建**：直接编辑 JS/CSS/HTML 文件，然后在 chrome://extensions/ 中点击扩展的刷新按钮
- **未配置测试或代码检查工具**

## 架构

### 脚本执行上下文

扩展在 bilibili.com 上运行于两个隔离的 JavaScript 世界中：

1. **MAIN world**（`content/interceptor.js`，`run_at: document_start`）：对 `window.fetch` 和 `XMLHttpRequest` 进行猴子补丁，在页面渲染前过滤 API 响应。运行在页面的 JS 上下文中，因此可以拦截网络请求。通过 `window.postMessage` 从内容脚本接收 UID 更新。

2. **Isolated world**（`content/bilibili.js` + `lib/storage.js` + `lib/github.js`，`run_at: document_idle`）：可访问 `chrome.storage` API。处理 DOM 操作——扫描评论/视频卡片、注入屏蔽按钮、移除被屏蔽内容。通过 `postMessage({ type: 'BILIBAN_UPDATE_UIDS' })` 将 UID 变更通知给 MAIN world 拦截器。

3. **Background**（`background/service-worker.js`）：监听 `chrome.storage` 变更，向所有 bilibili.com 标签页广播 `{ type: 'refresh' }` 消息。

### 数据流向

```
Popup (popup.js) ──写入──▶ chrome.storage.local
                                    │
                         service-worker.js 检测变更
                                    │
                         向所有标签页广播 { type: 'refresh' }
                                    │
                    bilibili.js refreshAll() 重新扫描 DOM
                    interceptor.js 从 storage 重新加载 UID
```

### 存储结构（`chrome.storage.local`）

- `biliban_blacklist`：`{ groups: [{ id, name, enabled, uids: number[] }] }`
- `biliban_sources`：`[{ id, owner, repo, path, branch, name }]` — 社区订阅仓库
- `biliban_github_token` / `biliban_gist_id` — GitHub Gist 同步凭证
- `biliban_power_mode` — 布尔值，启用高频 DOM 扫描（500ms 间隔）

### Shadow DOM 处理

Bilibili 使用带有 Shadow DOM 的 Web Components（`bili-comments`、`bili-comment-thread-renderer` 等）。内容脚本遍历多层 shadow root 以提取 UID 和注入屏蔽按钮。DOM 元素上的 `DONE` 标记（`__biban_done`）用于防止重复处理。

BewlyBewly 兼容性：`getBewlyShadowRoot()` 通过多种选择器策略（包括暴力扫描）定位 BewlyBewly 的 shadow host。其卡片在 `processBewlyCards()` 中单独处理。

### 关键模式

- `BilibanStorage`（`lib/storage.js`）是唯一的数据访问层——所有增删改查都通过它进行
- `bilibili.js` 中的 `CARD_SELECTORS` 是逗号分隔的选择器列表，覆盖不同 Bilibili 布局和扩展的所有已知视频卡片 CSS 选择器
- `extractCardUid()` 尝试多种策略（href 解析、data 属性）从卡片元素中获取 UP 主 UID
- 选组弹窗（`showGroupPicker`）以 fixed 定位的 div 注入，点击外部自动关闭

## 核心文件

- `content/interceptor.js` — API 层过滤（fetch/XHR 猴子补丁）
- `content/bilibili.js` — DOM 层过滤、按钮注入、Shadow DOM 遍历、BewlyBewly/Gate 兼容
- `lib/storage.js` — 所有数据操作（分组、UID、订阅源、导入导出、合并）
- `lib/github.js` — GitHub Gist 同步和 token 管理
- `popup/popup.js` — 扩展弹窗 UI（分组管理、导入导出、GitHub 同步、订阅）
- `manifest.json` — 扩展清单（MV3、权限、content script 注入配置）
