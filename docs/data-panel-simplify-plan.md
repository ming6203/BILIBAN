# BILIBAN · 数据面板简化改造计划

> 状态：**已实施（2026-10-30）**
> 记录时间：2026-10-30
> 目标版本：`1.2.0`（数据结构不兼容旧版，已升次版本号）
> 关联文档：`docs/data-panel-plan.md`（旧设计，已过时）、`docs/archive-plan.md`（归档方案，已废弃）

---

## 一、改造目标

把数据面板从“带配额、超额策略、归档分块、详细事件”的复杂系统，收敛为：

1. **只记录屏蔽发生的时间与类型**
   - 类型只保留 `video`（视频命中）和 `comment`（评论/回复命中）。
   - 不再保存 UID、分组 ID、BV 号、视频标题、评论内容、事件 ID 等任何明细。
2. **不再提供容量/刷盘策略设置**
   - 移除限制模式（数量/大小）、缓存配额、超额策略、告警百分比、批量刷盘条数/定时等用户设置。
   - 仍保留内部固定批量写入，避免每条事件都读写一次 `chrome.storage.local`。
3. **数据面板内显示真实存储占用，并支持按时间清理**
   - 概览卡显示 `biliban_block_events` 的实际字节数与记录条数。
   - 数据面板底部提供“清理 [时间] 之前的数据”行；时间控件默认显示已有数据的最早时间。
   - 点击「清理数据」时删除严格早于该时间的记录（不含该时间点），之后的保留。
   - 默认不自动清理；是否清理、清理到哪个时间点完全由用户点击决定。
4. **移除归档体系与数据备份功能**
   - 删除归档分块阈值、手动清理比例、自动清理开关等设置。
   - 删除数据面板的云端归档列表、下载/加载归档、下载记录等 UI。
   - 删除 `lib/backup-sync.js`（整个数据备份模块）。
   - 删除 popup「数据备份 / 推送数据到云 / 从云端恢复 / 按仓库链接恢复」相关按钮与代码。
   - 删除高级设置中的「备份仓库设置」以及「数据仓库可见性」。
   - 黑名单本身的云同步（分块推送/拉取、社区订阅）不受影响。

## 二、现状盘点

| 文件 | 当前职责 | 本次处理 |
|---|---|---|
| `content/stats-collector.js` | 内存缓冲、批量刷盘、配额/超额策略、记录 uid/bvid/title 等字段 | 重写为固定批量、只写时间与类型 |
| `lib/storage.js` | `getBlockStats()`、清空事件、高级设置读写 | 改为 v2 数据模型，新增存储大小与按时间清理 |
| `manage/stats.js` | 概览、折线图、归档 UI/下载/加载、配额表单、存储清理 | 删除归档与配额逻辑，新增存储信息与时间清理 |
| `manage/manage.html` | 数据面板卡片、高级设置表单、归档设置卡 | 删除归档卡片与旧配额字段，清理时间控件放到数据面板 |
| `manage/manage.css` | 归档列表、配额提示等样式 | 删除归档样式，补充存储信息/清理样式 |
| `lib/backup-sync.js` | 数据文件推送/恢复 + 归档分块/游标/下载记录 | **删除整个文件** |
| `popup/popup.js` | 数据备份推送/恢复、按仓库链接恢复 | 删除全部数据备份 UI 与代码 |
| `manifest.json` | `downloads` 权限（仅归档下载使用） | 删除该权限 |
| `docs/data-panel-plan.md` | 旧版数据面板/配额/归档设计 | 实施后加“已过时”说明 |
| `docs/archive-plan.md` | 归档方案 | 实施后标记为废弃 |

## 三、核心设计

### 3.1 新数据模型

存储键仍为 `biliban_block_events`，结构改为：

```js
{
  version: 2,
  video: [1730000000000, 1730000001000, ...],   // 视频命中时间戳（ms）
  comment: [1730000000500, ...],                // 评论/回复命中时间戳（ms）
  meta: {
    updatedAt: 1730000001000,
    migratedAt: 1730000001000                   // 仅迁移时写入
  }
}
```

设计说明：

- **类型由数组名表达**，每条记录只剩一个时间戳，不重复存 `type` 字符串。
- `video` / `comment` 两个数组的长度就是两类命中次数，总数是两者之和。
- 不保存 `id`：事件只需要时间+类型，不再需要去重键或明细定位。
- 不保存 `buckets` / `videoBuckets` / `commentBuckets`：折线图数据在读取时由时间戳实时聚合，避免同一份数据存两遍。
- 不保存 `aggregates`：该表已不在当前数据面板使用，本次彻底移除。
- 时间戳使用毫秒；展示、清理时间输入均按**本地时区**转换。
- 数组内不要求严格有序；迁移和合并时排序，日常追加不排序，避免每次刷盘都排序。

### 3.2 记录规则

- 评论命中：记录一个 `comment` 时间戳。
- 视频命中：记录一个 `video` 时间戳。
- 视频命中的会话级去重仍保留：内存中用 `bvid + uid` 判断同一视频同一用户只计首次，但**该键不落盘**。
- 评论仍依赖现有 DOM 标记避免同一评论重复计数。
- 保留「记录评论命中」「记录视频命中」两个开关（`recordComment` / `recordVideo`），默认都开。
- 删除已无意义的配置项：`recordSubtitle`、`saveVideoTitle`、`keepUidDetail`。

### 3.3 批量写入

用户不再配置刷盘阈值，但保留内部固定批量，避免性能退化：

- 固定缓冲：累计 **30 条** 或距上次刷盘 **5 秒**，先到先触发。
- 页面 `pagehide` 时兜底刷盘。
- 读取当前数据 → 追加到 `video` / `comment` 数组 → 更新 `meta.updatedAt` → 整体写回。
- 不设条数/大小上限，不做超额淘汰、不清空明细、不自动停写。
- 写入失败（例如 `QUOTA_BYTES` 超限）时：
  - 丢弃本批缓冲，避免无限重试；
  - 写入一个很小的错误标记键 `biliban_stats_write_error = { at, message }`；
  - 数据面板显示“存储空间不足，已暂停记录，请清理旧数据”；
  - 后续写入成功后清除该标记。
- 多个标签页同时写仍有 read-modify-write 覆盖风险（旧实现已存在）；本次不扩大范围处理，作为已知风险记录。

### 3.4 存储大小与时间清理

新增读取接口（`lib/storage.js`）：

- `getBlockStorageInfo()`：
  - `chrome.storage.local.getBytesInUse('biliban_block_events')` 获取真实字节数；
  - 返回 `{ bytes, total, videoCount, commentCount, firstTimestamp, lastTimestamp }`；
  - 若 `getBytesInUse` 不可用，降级为 `JSON.stringify(data).length` 估算。
- `clearBlockEventsBefore(cutoffTimestamp)`：
  - 过滤 `timestamp < cutoffTimestamp` 的记录；
  - 返回 `{ removed, remaining, removedVideo, removedComment }`；
  - 同时清除 `biliban_stats_write_error`（如果存在）。
- `countBlockEventsBefore(cutoffTimestamp)`：清理前统计将删除的数量。
- 不提供单独的“清空全部”接口；把时间设为当前/未来即可清理全部，保持入口单一。

数据面板底部展示（与概览、图表同屏，不再放到高级设置）：

```
⟳ 刷新    清理 [2026-10-01 10:05] 之前的数据  [清理数据]
```

交互规则：

- 时间控件默认值 = 已有数据的**最早时间**（按分钟显示）；没有数据时禁用。
- **默认不清理**：打开面板、刷新、切换 Tab 都不会删除任何数据。
- 点击「清理数据」时：
  - 先按当前时间值统计 `timestamp < cutoff` 的记录数；
  - 若为 0，提示“所选时间之前没有数据”，不写入；
  - 否则弹确认框，显示将删除的总数/视频数/评论数，并说明该时间点及之后保留；
  - 确认后执行清理并刷新概览、折线图和存储占用。
- 严格按 `timestamp < cutoff` 删除；恰好等于 cutoff 的记录**保留**。
- 清理完成后，时间控件重置为剩余数据的最早时间；若无剩余数据则清空并禁用。
- 不提供快捷“7/30/90 天”按钮，避免与“显示最早时间”的默认语义冲突。

### 3.5 折线图与概览

- 概览卡：
  - 总触发次数 = `video.length + comment.length`
  - 触发视频数 = `video.length`
  - 触发评论数 = `comment.length`
  - 近 7 天 = 两个数组中 `timestamp >= 7 天前` 的数量
  - 原「已记录 / 配额」卡改为「存储占用」：显示格式化后的字节数，副标题显示记录条数。
- 折线图：
  - `getBlockStats()` 读取时遍历两个数组，临时生成 `buckets` / `videoBuckets` / `commentBuckets`；
  - 现有 Canvas 绘图、按天/周/月聚合、7/30/90 天范围切换逻辑保持不变；
  - 不再从存储中读取预存的 buckets。
- 空态：无记录时显示现有空态文案，不显示 0 值曲线。

### 3.6 归档处理

本计划按“**彻底移除归档**”编写，理由：

- 归档的唯一目的就是长期保存明细历史；现在只保留时间+类型，且用户要求按时间清理，归档分块阈值已无意义。
- 保留两套历史（本地事件 + 云端分块）会继续增加复杂度和 UI 负担。

具体移除：

- 数据面板「📦 归档数据」卡片：云端分块列表、刷新、返回当前数据、下载、已下载列表、加载归档视图、删除记录。
- 高级设置「📦 归档设置」卡片：`archiveMergeMB`、`archiveCleanPct`、`archiveAutoClean`。
- `lib/backup-sync.js`：**整个文件删除**（含数据文件推送/恢复与全部归档逻辑）。
- `popup/popup.js`：删除「数据备份」「推送数据到云」「从云端恢复」「按仓库链接恢复」及对应代码。
- `popup/popup.html`：删除数据备份区、按仓库链接恢复区，以及 `backup-sync.js` 脚本引用。
- `manage/manage.html`：删除「备份仓库设置」卡、数据仓库可见性选择，以及 `backup-sync.js` 脚本引用。
- `manage/stats.js`：删除 `loadBackupSettings` / `saveBackupSettings`、数据仓库可见性读写逻辑。
- `manifest.json`：删除仅归档下载使用的 `"downloads"` 权限。
- 清理本地遗留键：`biliban_archive_cursor`、`biliban_archive_downloads`、`biliban_backup_settings`、`biliban_data_repo_visibility`。
- 云端仓库里已经存在的 `data/archive/part_*.json` 与 `data/backup/*.json` **不自动删除**；新版本不再读取它们，需要时由用户手动清理。

保留：

- 黑名单的 GitHub 云同步：分块推送/拉取、社区订阅、仓库可见性设置。
- 黑名单本地导入/导出与分块管理。

### 3.7 数据完整性修复（2026-10-30）

排查后发现原采集链路存在多处漏记，已修复：

| 漏记原因 | 修复 |
|---|---|
| 楼中楼回复命中只删除、不记录 | `processReplyRenderer` 命中时补记 comment |
| BewlyBewly 卡片命中只删除、不记录 | `processBewlyCards` 命中时补记 video |
| 视频统计要求当前页有 `bvid`，首页/搜索/推荐等场景全部漏记 | 删除 bvid 硬性要求，所有视频卡片都记录 |
| 视频按 `bvid+uid` 会话去重，不符合“每次触发都记录” | 删除会话去重，交给 DOM 元素的 `DONE` 标记避免同一元素重复处理 |
| API 层过滤掉的评论/视频不进入 DOM，永远不计数 | interceptor 通过 `BILIBAN_BLOCK_EVENT` 上报过滤数量；stats-collector 接收并记录 |
| interceptor 在 document_start 上报时采集器尚未加载 | interceptor 先缓存事件，采集器就绪后发送 `BILIBAN_STATS_READY` 再补发 |
| 多标签页同时读改写 `biliban_block_events` 会互相覆盖 | service worker 增加串行写入队列，所有 `BILIBAN_STATS_APPEND` 排队执行 |
| 设置读取完成前直接丢弃事件 | 改为短暂 deferred 队列，设置就绪后再按开关处理 |
| 5 秒刷盘窗口偏长，关闭页面前可能丢失 | 改为 20 条 / 1 秒，并在页面隐藏、pagehide、beforeunload 时兜底刷盘 |
| `top_replies` / `items` 过滤后未标记响应已修改 | 补上 `modified = true`，确保这些屏蔽真正生效并计数 |

其他扩展兼容性说明：

- BewlyBewly 路径已单独接入统计。
- 如果其他扩展在**我们之前**过滤/移除内容（尤其是抢先 monkey-patch `fetch` 并返回已过滤响应），我们的 interceptor 看不到原始条目，仍可能漏记；这部分无法完全控制。
- 如果其他扩展只改 DOM/样式，我们的 DOM 采集通常仍能工作；如果它直接移除元素且早于我们的脚本，也可能漏记。

## 四、逐文件改动清单

### 4.1 `content/stats-collector.js`

- 删除 `DEFAULT_ADV` 中全部配额/归档字段，只保留：
  ```js
  { recordComment: true, recordVideo: true }
  ```
- 删除 `flushBatch`、`flushInterval`、`eventLimitMode`、`maxEvents`、`maxEventsMB`、`overflowStrategy`、`byteWarnPct`、归档字段。
- 缓冲改为 `pendingVideo` / `pendingComment` 两个时间戳数组。
- 固定 `BATCH_SIZE = 20`、`FLUSH_INTERVAL_MS = 1000`（内部常量，不暴露设置）。
- 批量写入优先通过 `BILIBAN_STATS_APPEND` 交给 service worker 串行执行，消息失败时回退到直接写 storage。
- `flush()` 失败时写 `biliban_stats_write_error`；成功且此前有错误时清除。
- `collectBlockEvent()` 只接收类型；不要求 bvid，不做会话级视频去重，每次 DOM 命中都记录。
- `loadConfig()` 读取并只取 `recordComment` / `recordVideo`；读取完成前的事件进入 deferred 队列，完成后按开关处理。
- 增加 `visibilitychange`、`pagehide`、`beforeunload` 兜底刷盘。
- 监听 `BILIBAN_BLOCK_EVENT`：接收 interceptor 上报的 API 过滤数量；采集器就绪时发送 `BILIBAN_STATS_READY` 让 interceptor 补发早期缓存。
- 通过 `BilibanStorage` 的方法读写，保证迁移/规范化只有一处实现。

### 4.2 `lib/storage.js`

- 新增 v1 → v2 规范化与惰性迁移：
  - 识别 `{ version: 2, video: [], comment: [] }` 直接使用；
  - 识别旧 `{ events: [{ timestamp, type, ... }] }`，按 type 拆分时间戳；
  - 丢弃旧 `buckets`、`videoBuckets`、`commentBuckets`、`aggregates`、`meta.quotaStoppedAt`；
  - 迁移后写回 v2，并记录 `meta.migratedAt`。
- `getBlockStats()` 改为从 v2 数组计算：
  - 返回 `{ total, videoCount, commentCount, buckets, videoBuckets, commentBuckets, firstTimestamp, lastTimestamp, updatedAt }`；
  - 不再返回 `events` 明细、`quotaStoppedAt`。
- 新增 `getBlockStorageInfo()`、`countBlockEventsBefore(cutoff)`、`clearBlockEventsBefore(cutoff)`。
- 不保留单独的 `clearBlockEvents()`；清理全部通过把时间设到当前/未来完成。
- `getAdvancedSettings()` 返回规范化后的 `{ recordComment, recordVideo }`；旧配置中的其他字段忽略。
- `setAdvancedSettings()` 只保存上述两个字段。
- 新增 `cleanupLegacyKeys()`：删除旧归档键 `biliban_archive_cursor`、`biliban_archive_downloads`，以及已移除的数据备份设置键 `biliban_backup_settings`、`biliban_data_repo_visibility`（管理页初始化时调用一次）。
- 删除对 `aggregates` 的假设。

### 4.3 `manage/manage.html`

数据面板：

- 「已记录 / 配额」卡改为「存储占用」：
  - `id="stat-storage"` 显示 `0 B`；
  - 副标题增加 `id="stat-storage-label"`，显示“存储占用 · N 条”。
- 删除整个 `stats-archive-card`（云端归档列表、刷新、返回、已下载）。
- 数据面板底部操作行改为：
  - `stats-refresh` 刷新按钮；
  - `stats-cleanup-time`（`datetime-local`），默认值为已有数据最早时间；
  - `stats-clear` 按钮，文案改为「清理数据」；
  - `stats-hint` 状态提示。
- 不再保留「清空数据」按钮。

高级设置：

- 删除「📊 数据面板设置」整张卡片（限制模式、配额、刷盘、超额策略、告警百分比）。
- 删除「💾 数据存储」卡（存储大小与时间清理全部集成在数据面板）。
- 「🗂️ 记录设置」保留评论/视频两个开关。
- 删除整个「📦 归档设置」卡片。
- 将原「☁️ 备份仓库设置」卡改为「☁️ GitHub 仓库设置」：只保留「备份仓库名称」（所有者由 Token 决定，保存到 `biliban_repo_name`）；删除「与黑名单同一仓库」「独立数据仓库名称」。
- GitHub 账户设置保留 Token 与黑名单仓库可见性，删除数据仓库可见性。

### 4.4 `manage/stats.js`

删除：

- `archEl`、`archivedView`、`archivedStats`。
- `downloadArchivePart`、`renderArchiveUI`、`loadArchivePart`、`exitArchiveView`。
- 归档刷新/返回事件监听。
- `advEl` 中旧配额/刷盘/归档字段。
- `syncLimitModeUI`、`updateQuotaUsed`。
- `readAdvForm` 中的配额、归档字段。
- `render()` 末尾的 `renderArchiveUI()` 调用。
- 概览中的配额百分比、颜色告警、`quotaStoppedAt` 提示。

新增/调整：

- `DEFAULTS` 仅保留 `recordComment` / `recordVideo`。
- 新增 `renderStorage(info)`：更新存储占用、条数，并把清理时间控件设为最早时间。
- 新增 `fmtDateTime`、`toInputValue`、`parseCleanupTime`。
- 清理按钮流程：取 cutoff → `countBlockEventsBefore` → 0 则提示 → `confirm` → `clearBlockEventsBefore` → `render`。
- 清理成功后提示“已清理 N 条，剩余 M 条”；时间控件自动重置到新的最早时间。
- `renderOverview()` 不再显示配额、百分比、告警色。
- `loadAdvSettings()` / `saveAdvSettings()` 只处理两个记录开关。
- 删除 `loadBackupSettings()` / `saveBackupSettings()` 及备份仓库表单事件。
- 新增「GitHub 仓库设置」：读取/保存 `BilibanGithubSync.getRepoName()` / `setRepoName()`，只允许仓库名。
- `loadGithubAccount()` 同时加载仓库名、Token 与黑名单仓库可见性，删除数据仓库可见性。
- 对外接口只保留 `render`、`loadAdvSettings`、`loadGithubAccount`。

### 4.5 `manage/manage.css`

- 删除 `.archive-*`、`.quota-used` 等不再使用的样式。
- 新增数据面板清理行样式：标签、时间输入宽度、按钮间距、自动换行。
- 复用现有 `.stats-advanced`、`.adv-grid`、`.opt-item` 布局。

### 4.6 `lib/backup-sync.js`

- **删除整个文件**：数据备份、云端恢复、按仓库链接恢复、归档分块全部不再提供。
- 同步删除 `manage/manage.html`、`popup/popup.html` 中的 `../lib/backup-sync.js` 脚本引用。
- `biliban_backup_settings`、`biliban_data_repo_visibility` 加入遗留键清理列表。

### 4.7 `popup/popup.js` / `popup/popup.html`

- 删除「数据备份」区（推送数据到云 / 从云端恢复）。
- 删除「云端恢复（按仓库链接）」区及对应 JS 逻辑。
- 删除 `other-push`、`other-restore`、`other-browse`、`other-file-list` 等 DOM 与事件处理。
- 保留「云端备份」「社区订阅」两个现有 tab：分块推送/拉取、订阅源管理、仓库可见性设置不受影响。
- popup 的本地导入导出、分块同步、订阅功能不受影响。

### 4.8 `manifest.json`

- 删除 `"downloads"` 权限（确认全仓库仅归档下载使用）。
- 版本号从 `1.1.0` 升到 `1.2.0`。

### 4.9 文档

- 本文档作为本次改造计划。
- 实施完成后：
  - `docs/data-panel-plan.md` 顶部标注“部分设计已被 `data-panel-simplify-plan.md` 取代”；
  - `docs/archive-plan.md` 顶部标注“已废弃，归档功能已移除”。

## 五、旧数据迁移

### 5.1 事件迁移

旧结构：

```js
{
  events: [
    { id, type, uid, groupId, videoBvid, videoTitle, timestamp }
  ],
  buckets: {},
  videoBuckets: {},
  commentBuckets: {},
  aggregates: {},
  meta: { lastSynced, quotaStoppedAt }
}
```

映射规则：

```text
timestamp 有效（> 0）时：
  type === 'video'  → video.push(timestamp)
  其他/缺失 type    → comment.push(timestamp)
```

- 迁移后按时间升序排序。
- 不去重（保留原计数；同一毫秒多条也保留）。
- 丢弃所有明细字段、buckets、aggregates、quotaStoppedAt。
- 迁移是**不可逆**的；旧的 UID/BV/标题等明细将不再存在。
- 建议在实施/升级前提示用户导出旧版 `biliban_blacklist` 或旧事件备份；如果用户明确不需要明细，可跳过提示。

### 5.2 设置迁移

旧 `biliban_advanced_settings`：

```js
{
  flushBatch, flushInterval, eventLimitMode, maxEvents, maxEventsMB,
  overflowStrategy, byteWarnPct, archiveMergeMB, archiveCleanPct,
  archiveAutoClean, recordComment, recordVideo, recordSubtitle,
  saveVideoTitle, keepUidDetail
}
```

新设置只保留：

```js
{ recordComment: true, recordVideo: true }
```

- 读取时忽略旧字段；缺失开关按默认 `true`。
- 首次读取后可回写精简后的配置（可选）。

### 5.3 遗留键清理

- `biliban_archive_cursor`
- `biliban_archive_downloads`
- `biliban_backup_settings`
- `biliban_data_repo_visibility`

在管理页初始化或扩展更新时 `chrome.storage.local.remove([...])`。云端 `data/archive/` 文件不自动删除。

## 六、边界与风险

| 风险 | 说明 | 对策 |
|---|---|---|
| `storage.local` 10MB 上限 | 不再有配额设置，长期积累可能写满 | 显示真实占用；用户按时间清理；写入失败时暂停并提示，不自动删除 |
| 多标签页并发写 | 读-改-写可能互相覆盖 | 已有风险；本次保持现状，后续可考虑集中到 service worker 写入 |
| 迁移不可逆 | 旧明细会被永久丢弃 | 迁移前告知；如需保留先导出旧数据 |
| 图表每次渲染重新聚合 | 数据量很大时有 O(n) 开销 | 仅在切换数据面板/刷新时计算；必要时加内存缓存 |
| 时区/边界 | datetime-local 是本地时间，存储是 ms 时间戳 | 统一用本地时间转 `new Date(...).getTime()`；严格 `< cutoff` |
| 旧云端数据备份残留 | 新版本不再读取 `data/backup/`、`data/archive/` | 文档说明；不自动删除用户云端数据 |
| 写入错误标记本身也占空间 | 配额满时可能写不进去 | 标记很小；写失败时仅内存提示，UI 仍可通过 `getBytesInUse` 判断接近上限 |

## 七、实施顺序

### M1：数据层与迁移（核心）
1. `lib/storage.js` 新增 v2 规范化/迁移、`getBlockStats()` 重写、`getBlockStorageInfo()`、`clearBlockEventsBefore()`。
2. 用 mock 数据验证 v1 → v2、边界清理、空数据。

### M2：采集层
3. 重写 `content/stats-collector.js`：固定批量、只写时间戳、错误标记。
4. 验证评论/视频记录、视频会话去重、设置开关、页面卸载刷盘。

### M3：数据面板 UI
5. `manage/manage.html` 概览卡改为存储占用，删除归档卡。
6. `manage/stats.js` 删除归档与配额逻辑，接入新统计接口。
7. `manage/manage.css` 清理归档样式。

### M4：数据面板清理控件
8. 数据面板底部加入时间控件（默认最早时间）与「清理数据」按钮。
9. 实现数量预统计、确认弹窗、严格 `< cutoff` 清理、清理后刷新并重置时间。
10. 高级设置只保留记录开关，删除旧配额字段与归档设置卡。

### M5：移除归档与数据备份
11. 删除 `lib/backup-sync.js` 整个文件及两个页面的脚本引用。
12. `popup/popup.js` / `popup/popup.html` 删除数据备份、云端恢复、按仓库链接恢复。
13. `manage/manage.html` / `manage/stats.js` 删除备份仓库设置与数据仓库可见性。
14. `manifest.json` 删除 `downloads`、升版本。
15. 清理遗留 storage 键。

### M6：回归与文档
16. `node --check` 所有改动文件。
17. mock 端到端：管理页、popup、迁移、记录开关。
18. 实机 `chrome://extensions/` 刷新验证。
19. 更新旧文档状态说明。

## 八、验收标准

- [ ] 新产生的记录只包含时间戳和类型，storage 中不再出现 uid、BV、标题、分组、事件 id。
- [ ] `buckets` / `aggregates` 不再写入；图表由时间戳实时聚合。
- [ ] 高级设置中不再有限制模式、配额、超额策略、刷盘阈值、告警百分比、归档设置。
- [ ] 数据面板概览显示真实存储占用与记录条数。
- [ ] 数据面板底部时间控件默认显示已有数据的最早时间。
- [ ] 默认不清理；只有点击「清理数据」并确认后才删除。
- [ ] 可指定时间清理该时间之前的记录；恰好等于该时间的记录保留；确认框显示删除/保留数量。
- [ ] 清理后图表、概览、存储占用同步更新，时间控件重置为剩余数据最早时间。
- [ ] 高级设置中不再有数据存储、时间选择、限制模式、配额、超额策略、刷盘阈值、归档设置。
- [ ] 数据面板不再有归档卡片、云端分块下载、已下载列表。
- [ ] popup 不再有「数据备份」「推送数据到云」「从云端恢复」「按仓库链接恢复」。
- [ ] 高级设置不再有「备份仓库设置」与数据仓库可见性。
- [ ] GitHub 仓库名可修改并持久化，分块推送/拉取使用新仓库名。
- [ ] `lib/backup-sync.js` 已删除，页面不再引用。
- [ ] 旧 `biliban_archive_cursor` / `biliban_archive_downloads` / `biliban_backup_settings` / `biliban_data_repo_visibility` 被清理。
- [ ] `manifest.json` 不再包含 `downloads` 权限。
- [ ] 黑名单分块云同步、社区订阅、本地导入导出仍正常。
- [ ] 记录开关生效：只开评论时仅记录评论时间戳，只开视频时仅记录视频时间戳。
- [ ] `node --check` 通过，管理页/popup 无运行时错误。

## 九、已确认的决策

1. **归档与数据备份全部移除**：数据面板归档 UI、`backup-sync.js` 整个模块、popup 数据备份/恢复、备份仓库设置、数据仓库可见性、`downloads` 权限全部删除。
2. **保留黑名单云同步**：分块推送/拉取、社区订阅、黑名单仓库可见性不受影响。
3. **默认不清理**：不自动清理、不按容量淘汰；打开面板/刷新不会删除数据。
4. **清理入口只有一个**：数据面板底部「清理数据」+ 时间控件；原来的「清空数据」被替换，不再保留单独的全部清空按钮。
5. **时间控件显示最早数据时间**：默认值为已有数据的最早时间；点击清理时删除严格早于该时间的记录，等于该时间的记录保留。
6. **高级设置不再承载存储/时间清理或数据备份**：只保留记录类型开关、备份仓库名称、GitHub Token、黑名单仓库可见性。
7. **采用两数组存储**：`video: [ts...]` / `comment: [ts...]`，不保存 uid、BV、标题、分组等明细。
