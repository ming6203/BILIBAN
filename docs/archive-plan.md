# BILIBAN · 数据归档（Archive）功能 技术方案

> 状态：**待审核**（审核通过后按里程碑实施）
> 目标：全量明细/聚合表备份到 GitHub 后**归档（不计配额）**，打标记可回顾，支持下载过往数据分析，可在数据面板管理（下载/删除）。

---

## 一、需求拆解

| 需求 | 说明 |
|---|---|
| 归档不计配额 | 全量 `events[]` + `aggregates{}` 上传 GitHub 后**从本地清除**，释放 `biliban_block_events` 配额占用 |
| 打标记便于回顾 | 每个归档数据集带 `meta.json`（id/时间/事件数/时间范围/大小等），数据面板列表展示 |
| 下载过往数据 | 数据面板列出云端归档数据集，可下载 `events.json`/`aggregates.json` 到本地做分析 |
| 下载管理 | 数据面板显示「可下载」（云端）与「下载完成」（本地记录），可删除下载记录 |
| 内容不重复 | 归档 = **迁移**（上传当前全部 → 本地清空），两次归档天然无重叠 |
| 衔接旧数据 | 本地是唯一数据源；归档 2 只含归档 1 之后的新数据，时间连续无遗漏 |

---

## 二、核心设计决策

### 决策 1：归档 = 迁移，不是复制（这是"不重复+完整衔接"的关键）

```
归档前本地:  events[E1..En]  aggregates{A}  buckets{历史}
   │ ① 上传全部 events + aggregates + 生成 meta → GitHub data/archive/<id>/
   │ ② 全部上传成功 → 本地 events=[]、aggregates={}（释放配额）
   │    buckets/videoBuckets/commentBuckets 保留（历史曲线不丢，一年 365 条极小）
   ▼
归档后本地:  events[]  aggregates{}  buckets{历史不变}
下次采集 → 新事件 E(n+1).. → 再次归档上传的只有新数据 → 无重叠、时间连续
```

- **为什么不需要游标**：本地只保留"未归档"的数据，归档即清空。二次归档上传的内容天然是"上次归档之后"的数据，**不可能重复，也不可能遗漏**（pending 缓冲里未刷盘的少量事件仍留本地，下次归档自然带上）。
- **失败安全**：② 的本地清空**只在全部文件上传成功且 meta 写入后**执行。中途失败 → 本地数据原样保留 → 重试（PUT 覆盖同文件，幂等）→ 不会产生重复文件。

### 决策 2：数据集幂等 = "文件级 PUT 覆盖 + 数据集 id 唯一"

- 数据集 id：`archive_<YYYYMMDD_HHmmss>`（时间戳唯一，不会重复生成）
- 上传单个文件总是 PUT（存在即覆盖）：重试/续传安全
- 数据集级防重复：上传前 GET `meta.json`，已存在则提示"该数据集已存在"并跳过（防御性，正常流程不会触发）

### 决策 3：归档数据集的 GitHub 目录结构

```
data/archive/
  ├── archive_20260909_153000/
  │     ├── meta.json          ← 标记（回顾用）
  │     ├── events.json        ← 全量事件明细（>8MB 原始自动分块 events_0001.json...）
  │     └── aggregates.json    ← 聚合表快照
  └── archive_20260910_102030/
        └── ...
```

### 决策 4：meta.json 标记 schema（回顾/列表的数据源）

```json
{
  "id": "archive_20260909_153000",
  "version": 1,
  "createdAt": 1700000000000,
  "timeRange": { "from": 1700000000000, "to": 1700100000000 },
  "eventCount": 5230,
  "videoCount": 120,
  "commentCount": 5110,
  "aggCount": 800,
  "sizeBytes": 1234567,
  "chunkCount": 1,
  "source": "manual"
}
```

### 决策 5：本地存储键

| 键 | 内容 |
|---|---|
| `biliban_archive_index` | 已归档数据集索引：`[{ id, uploadedAt, eventCount, aggCount, timeRange, sizeBytes }]`（本地回顾缓存） |
| `biliban_archive_downloads` | 下载记录：`[{ id, fileName, downloadedAt, sizeBytes }]` |

---

## 三、核心流程

### 3.1 归档并上传（手动，数据面板按钮）

```
点击「归档并上传当前数据」
  ├─ 1. 读本地 biliban_block_events（events + aggregates + buckets）
  ├─ 2. 无数据（events 空且 aggregates 空）→ 提示"没有可归档的数据"
  ├─ 3. 生成 id = archive_<YYYYMMDD_HHmmss>
  ├─ 4. 组装 meta（时间范围取 events 首尾 timestamp、计数、估算字节）
  ├─ 5. 上传（复用 backup-sync 基础设施，走数据仓库）：
  │     ├─ data/archive/<id>/meta.json      (PUT)
  │     ├─ data/archive/<id>/events.json     (PUT；超大自动分块 events_0001.json...)
  │     └─ data/archive/<id>/aggregates.json (PUT)
  │     └─ 每文件先 _getDataFileInfo 拿 sha → 覆盖更新
  ├─ 6. 全部成功 → 清空本地 events/aggregates（保留 buckets）→ 写 biliban_archive_index
  └─ 7. 提示「已归档 N 事件 / M 聚合键，配额已释放」
```

### 3.2 云端列表（可下载）

```
刷新 → listArchiveRepos(仓库) → 列 data/archive/ 子目录（contents API type:'dir'）
  → 逐个读 <id>/meta.json → 汇总列表（id/时间范围/事件数/大小）
  → 与 biliban_archive_downloads 比对 → 标出"已下载"
```

### 3.3 下载（分析用）

```
点击「下载」
  ├─ fetch（带 token，私有仓库可用）拉 events.json（含分块合并）
  ├─ URL.createObjectURL(blob) → chrome.downloads.download({ url, filename: 'biliban_archive_<id>_events.json' })
  └─ 成功后写 biliban_archive_downloads 记录
```

> **为什么不用 raw URL 直连**：`chrome.downloads` 无法附加 Authorization header，私有仓库 raw 会 404；fetch 带 token 取 blob → objectURL 下载可同时支持私有/公共仓库，且 token 不暴露在下载请求里。

### 3.4 下载管理（删除）

```
「下载完成」列表每项 → [删除记录] → 从 biliban_archive_downloads 移除
```
> 说明：扩展无法删除用户下载目录里的文件，删除的是**下载记录**（文件保留在用户下载目录，便于分析留存）；如需连文件一起删，提示用户手动删。

### 3.5 回顾

- 数据面板「归档数据」区：按时间倒序列出全部归档数据集（meta 摘要：时间范围/事件数/大小）
- 本地 `biliban_archive_index` 缓存最近列表（离线也能看），云端列表为准

---

## 四、边界与容错

| 场景 | 处理 |
|---|---|
| 上传中途失败（网络/API） | 本地数据**不清空**，提示重试；重试 PUT 覆盖同文件，幂等 |
| 数据集已存在（meta GET 命中） | 跳过并提示，不重复上传 |
| events 超大（>8MB 原始） | 自动分块 `events_0001.json...`，meta 记 `chunkCount`，下载时合并 |
| 配额联动 | 归档后本地 events/aggregates 清空 → 数据面板"已记录"归零、配额释放 |
| 归档时缓冲未刷盘 | pending 中的少量事件仍留本地，下次归档自然带上（无丢失，仅延迟） |
| 下载失败 | 不写下载记录，提示重试 |
| 仓库不存在/无 data/archive/ | 列表为空并提示（不会报错） |
| 删除下载记录 | 仅删记录，文件保留（用户可手动清理） |

---

## 五、UI 设计（数据面板第三个区块「归档数据」）

```
┌─ 📦 归档数据 ─────────────────────────────┐
│ [归档并上传当前数据] [刷新云端列表]           │
│                                           │
│ 云端归档（可下载）  [点按 meta 摘要排序展示]    │
│   archive_20260909_153000                │
│   5000 事件 · 2026-09-01 ~ 2026-09-09 · 1.2 MB  [下载] │
│   ...                                    │
│ 已下载（下载完成）                          │
│   biliban_archive_20260909_153000_events.json  │
│   2026-09-10 14:30 下载 · 1.2 MB  [删除记录]    │
└──────────────────────────────────────────┘
```

---

## 六、manifest 变更

- 新增权限：`"downloads"`（chrome.downloads API 下载归档文件）
- 无需新增 host_permissions（复用现有 github.com API 访问）

---

## 七、里程碑（M10-M13）

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M10 | `lib/backup-sync.js` 归档核心：`uploadArchive()`（组装 meta/上传/分块/幂等）、`listArchives()`、`readArchiveEvents()` | 模拟上传成功→本地清空；失败→保留；重试幂等 |
| M11 | 数据面板归档 UI：归档按钮/云端列表/下载记录/删除记录 | HTML 元素 + 事件绑定断言 |
| M12 | `chrome.downloads` 下载（fetch blob → objectURL）+ manifest downloads 权限 | manifest 权限 + 下载调用路径 |
| M13 | 全链路验证：归档→列表→下载→删除；配额释放；衔接连续性（两次归档无重叠） | hermes-verify- 临时脚本 + 实机 |

依赖：M10 依赖现有 backup-sync（M6-M9 已交付）；M11/M12 依赖 M10；M13 收尾。

---

## 八、待确认问题（审核时请拍板）

1. **归档触发**：仅手动按钮？还是高级设置加「配额达 X% 自动归档」开关（默认关）？
2. **下载粒度**：每个数据集一个「下载」按钮下载 events.json（+aggregates 另按钮），还是打包成一个文件？
3. **删除下载记录**：只删记录（文件留在下载目录）可以吗？还是需要尝试清理文件？
4. **聚合表归档后本地重置为空**（新命中重新累计）——确认可接受？还是希望聚合表只归档"增量"（保留本地累计）？
