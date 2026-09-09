# BILIBAN · 数据面板 + 备份扩展 开发计划

> 目标：
> 1. 新增「数据面板」页面，记录黑名单的实际触发情况，用折线图描绘触发频率曲线
> 2. 扩充备份能力：将聚合表、事件数据、设置等"其他数据"纳入 GitHub 备份/恢复，跨设备同步使用数据

---

## 一、需求拆解

| 需求 | 说明 |
|---|---|
| 记录触发屏蔽的**视频数量** | 当某视频页面因命中黑名单而隐藏了 ≥1 条评论/卡片时，计数一次 |
| 记录触发屏蔽的**评论数量** | 命中黑名单被隐藏的评论/回复总数 |
| 记录**屏蔽时间** | 每次命中的时间戳，用于按时间聚合 |
| 描绘**触发频率曲线** | 按时间维度聚合（天/周/月）计数，绘制折线图 |
| 面板内**图表** | 用收集的数据画折线图 |

---

## 二、整体方案选型

### 页面注册方式（二选一，推荐 A）

**方案 A（推荐）：在现有管理面板内新增第三个 Tab「📊 数据面板」**
- 沿用 `manage/manage.html` 的 tab 导航（当前有「黑名单管理」「评论扫描」），加一个 `data-tab="stats"` 的 tab 页
- 优点：复用 manage.css 主题、header、无新增 manifest 配置、架构一致（popup 轻量、管理面板承载重逻辑）
- 缺点：管理面板已较重，页面加载需额外初始化

**方案 B：独立页面 + manifest 注册**
- 新建 `stats/stats.html`，在 manifest `web_accessible_resources` 或新 tab 打开
- 缺点：多一个入口/配置，与现有架构割裂，不推荐

> 采用 **方案 A**：数据面板作为管理面板的第三个 Tab。

---

## 三、数据模型（storage 结构）

新增存储键 `biliban_block_events`（`chrome.storage.local`），沿用 `BilibanStorage` 数据层模式。

```js
{
  // 每次屏蔽命中记录一条（评论/视频分别记录，便于分别统计）
  events: [
    {
      id: 'uuid',            // 唯一 id（Date.now()+随机，或自增）
      type: 'comment',       // 'comment'（评论/回复）| 'video'（视频卡片命中）
      uid: 12345678,         // 被屏蔽的用户 UID
      groupId: 'xxx',        // 命中的黑名单分组 id（可选）
      videoBvid: 'BV1xx',    // 【必存·去重键】BV 号不可改、全局唯一；标签页为 av 号时先解析成 bvid
      videoTitle: 'xxx',     // 【仅展示，可选】标题可改、可重复，绝不作为去重键
      timestamp: 1700000000000  // 触发时间（ms 时间戳）
    }
    // ... 去重：同一视频同一 uid 的视频命中，按 `videoBvid + uid` 只计首次
  ],
  meta: {
    lastSynced: 1700000000000
  }
}
```

> **去重键 = `videoBvid + uid`（BV 号唯一性保证正确去重）**；`videoTitle` 只用于数据面板明细的友好展示，可关闭以省空间，不影响去重。

### 重要设计决策：去重与量级控制
- **视频命中去重**：用一个 `hiddenVideos` 集合（`bvid_uid` 组合）记录本次会话/本次页面已经算过视频命中的键，避免 SPA 滚动/渲染重扫时同一被屏蔽 UP 主视频被反复计数。
- **评论命中**：评论区往往大量滚动，用 `__biban_counted` 标记避免对同一评论 DOM 重复计数（类似现有 `DONE` 标记）。
- **视频标题去重映射表**：标题单独存一份 `bvid → title` 映射（同视频多次命中只存一次），事件本身只存 `videoBvid`，查询标题时从映射表取。避免为每条事件重复塞入标题，显著压缩存储（同一视频命中几十次也不重复占用标题空间）。
- **缓存配额（用户可调）**：高级设置提供「缓存配额」- 事件条数上限（默认 50000）。面板实时显示「已使用 条数 / 配额」与估算字节空间。

#### 超额应对策略（配额已满时，三级自动递进）
用户命中数超过配额后，按以下等级自动降级，保证 `storage.local` 永不超配额：

1. **停写明细、转聚合（推荐默认）**：`events` 数组达到配额上限后，不再追加明细事件；改为维护一个按 **`bvid+uid`** 的**聚合计数表** `{ count, firstTs, lastTs }`，只累加次数和时间，不占明细空间。频率曲线仍可基于 `lastTs` 聚合绘制，只是失去单条明细。
2. **淘汰最早的明细**：若仍想保留明细，可开启"淘汰最早"——新事件进来时删除数组最早的一条，保持始终 ≤ 配额。频率曲线稍损失最早数据。
3. **只保留聚合、清空明细**：极端情况下（配额极小 / 用户明确要求）直接清空明细数组，仅保留聚合计数 + 时间桶，曲线基于时间桶绘制。
4. **兜底硬上限**：无论何种策略，写入前都检查估算字节，若接近 `storage.local` 配额（如 90%），触发「停写 + 提示清理」。

> 默认推荐：**策略 1（停写明细转聚合）**，在保留曲线可用性的同时控制体积。策略 2/3 作为高级设置里的可选项。

#### 聚合表独立配额与清理策略

聚合表（`aggregates{}`：`bvid+uid → { count, firstTs, lastTs }`）本身也会增长，需**独立配额 + 清理策略**，避免无限膨胀：

| 设置项 | 说明 | 默认 |
|---|---|---|
| **聚合配额（键数上限）** | `aggregates` 最多保留多少个 `bvid+uid` 键 | `10000` |
| **聚合清理策略** | 达到聚合配额后的处理：①按 LRU 淘汰最久未命中的键（默认）②只留保留期内的键（如 90 天）③降级为按天 time-bucket | `LRU 淘汰` |
| **聚合保留期（天）** | 清理时超过保留期的聚合键删除（配合策略②） | `90` |

清理后仍可基于剩余聚合键（或 time-bucket）绘制频率曲线；time-bucket 按天一条（365 天 ≈ 365 条），几乎永不满，是曲线数据的最终兜底。

> 聚合表键是 `bvid+uid` **唯一**的，重复命中只更新 `count`/`lastTs`，**不新增条目**——这是它比明细省空间的核心。

---

## 四、采集埋点（content script）

在 `content/bilibili.js` 的屏蔽命中点注入计数逻辑。现有命中点：
- `blockedUids.has(uid)` 命中评论 → 评审 `handleCommentRenderer` / 评论刷新逻辑
- `blockedUids.has(uid)` 命中视频卡片 → 评审 `处理视频推荐/卡片` 逻辑
- `blockedUids.has(uid)` 命中弹幕/搜索等（如需，可选扩展）

采集方式（二选一）：

- **方式 1：直接写 `chrome.storage.local`**
  - content script（isolated world）可访问 `chrome.storage`，每次命中 `storage.local.get` + `set`。
  - 缺点：高频命中时频繁读写 storage，性能差，可能被 storage 配额/限频影响。
  
- **方式 2：批量缓冲后写入（推荐）**
  - 在 content 层维护内存缓冲 `pendingEvents[]`（session 级），累积 N 条（如 20 条）或定时（如 3 秒）**批量**写一次 storage。
  - 缺点：进程销毁时缓冲丢失（可接受，不影响主功能）。

> 采用**方式 2（批量缓冲 + 定时/定量刷盘）**，兼顾性能与可靠。

新增 `content/stats-collector.js`（isolated world，随 bilibili.js 一起注入），提供 `collectBlockEvent(type, uid, ctx)` 接口，由 `bilibili.js` 的命中点调用。

---

## 五、数据面板 UI（manage.html 第三 Tab）

### Tab 结构
```html
<nav class="tabs">
  <button class="tab active" data-tab="blacklist">📋 黑名单管理</button>
  <button class="tab" data-tab="scan">🔍 评论扫描</button>
  <button class="tab" data-tab="stats">📊 数据面板</button>
</nav>
<section class="tab-content" id="tab-stats"> ... </section>
```

### 面板内容分区
1. **概览统计卡**：总触发次数、触发视频数、触发评论/回复数、最近 7 天触发数、**存储用量（已记录 N 条 / 配额 M 条 · 占用约 X KB）**；接近配额时高亮提示
2. **频率折线图**（核心）：X 轴时间（按天/周/月聚合，可切换粒度），Y 轴触发次数
   - 支持图例：总触发、视频触发、评论触发（三条曲线或可切换）
3. **时间范围筛选**：最近 7/30/90 天，或自定义
4. **明细列表**（可选，分页）：最近 N 条触发记录（时间、类型、UID、视频）
5. **清空数据**按钮

### 图表实现 —— 无外部库（推荐）用 Canvas 自绘折线图
- 项目是**纯原生 JS、无构建系统、无 CDN 依赖**（Chrome 扩展需加载本地资源，不便引 CDN；且离线可用）。
- 用 `<canvas>` 手绘折线图：坐标轴、刻度、数据点、折线、tooltip（悬浮显示某天数值）。
- 优点：零依赖、轻量、符合项目纯净风格；缺点：需自写绘图逻辑（约 150-250 行）。

> 备选：如希望更省事，可考虑零依赖轻量库（chart.js 无需求本地打包），但会增加体积。**推荐 Canvas 自绘**。

### 新增文件
- `manage/stats.js` — 数据面板初始化、聚合、绘图逻辑
- `stats` canvas 相关 CSS 加入 `manage/manage.css`

---

## 六、存储访问层（lib/storage.js 扩展）

在 `BilibanStorage` 增加数据采集相关方法（遵循现有数据层模式）：
```js
async addBlockEvent(type, uid, ctx)   // 追加一条（内部走批量缓冲由 collector 调用）
async getBlockStats()                  // 返回总数/视频数/评论数
async getBlockEventsByDay(days)        // 按天聚合，供绘图
async clearBlockEvents()
```

---

## 七、实施步骤（里程碑）

### M1：数据采集（content 层）
1. 新建 `content/stats-collector.js`：内存缓冲 + 批量刷盘 + `collectBlockEvent()`
2. 在 `content/bilibili.js` 的评论、视频命中点调用采集（视频命中含去重键）
3. `manifest.json` content_scripts 增加 stats-collector.js（随 bilibili.js 注入，放其后）
4. `lib/storage.js` 增加 `BilibanStorage` 的统计方法
5. 验证：真实打开被屏蔽用户多的视频，确认 storage 有累积事件

### M2：数据面板 UI
6. `manage/manage.html` 增加「数据面板」Tab + 概览卡 + canvas 容器
7. 新建 `manage/stats.js`：读统计、按天/周/月聚合
8. `manage/manage.css` 增加面板卡片与 canvas 样式

### M3：折线图绘制
9. 在 `stats.js` 实现 Canvas 折线图（坐标轴、刻度、折线、图例、粒度切换、tooltip）
10. 面板挂载事件：切到 stats tab、时间范围切换、清空数据

### M4：打磨与验证
11. 空数据态展示
12. 量级上限策略（去重 + 超限合并/淘汰）
13. 全量语法检查 + 临时 ad-hoc 验证脚本
14. 实机 `chrome://extensions/` 刷新验证

---

## 八、关键风险与对策

| 风险 | 对策 |
|---|---|
| 高频命中的 storage 写入性能 | 内存缓冲批量刷盘；视频命中去重 |
| storage.local 膨胀超配额 | events 设上限，超限合并/淘汰 |
| 同视频渲染重扫重复计数 | `bvid_uid` 去重集 + DOM `__biban_counted` 标记 |
| 评论 DOM 动态插入漏计数 | 沿现有 `handleCommentRenderer` 的 MutationObserver/滚动监听注入 |
| 折线图在无数据时显示 | 空态文案 + 置零坐标基线 |

---

## 九、验收标准

- [ ] 打开被屏蔽用户较多的页面，storage 中能发起 `biliban_block_events`
- [ ] 数据面板显示总触发数、视频数、评论数
- [ ] 折线图按天/周/月正确绘制触发频率曲线（纯 Canvas，无外部依赖）
- [ ] 支持时间范围切换与粒度切换
- [ ] 同一视频同一 uid 的视频命中不重复计数
- [ ] 清空数据功能正常
- [ ] 全程 `node --check` 语法通过，无临时文件残留

---

## 十、高级设置页面（新增）

为数据面板/采集功能增加一个「高级」设置区域，承载需要用户微调的底层参数。**跟随数据面板 Tab**，作为其内部一个 Tab 页或分区。

### 1. 高级设置涵盖内容

| 设置项 | 说明 | 默认值 |
|---|---|---|
| **批量刷盘阈值（条数）** | 内存缓冲累计到 N 条时刷新到 storage | `50` |
| **批量刷盘定时（秒）** | 距上次刷盘超过 T 秒且缓冲非空时兜底刷新（空缓冲跳过，不产生写入） | `10` |
| **缓存配额（事件上限）** | `events` 明细数组最大条数，达到后按「超额策略」降级 | `50000` |
| **超额策略** | 配额满时的处理：①停写明细转聚合（默认）②淘汰最早明细 ③清空明细只留聚合 | `转聚合` |
| **存储配额字节告警** | 写入前估算字节，达 `storage.local` 配额 X% 时停写 + 提示清理 | `90%` |
| **聚合配额（键数上限）** | `aggregates` 聚合表最多保留多少个 `bvid+uid` 键 | `10000` |
| **聚合清理策略** | 聚合配额满时：①LRU 淘汰最久未命中（默认）②只留保留期内 ③降级为按天 time-bucket | `LRU` |
| **聚合保留期（天）** | 清理时删除超过保留期的聚合键（配合策略②） | `90` |
| 事件类型记录开关 | 是否记录视频命中 / 评论命中 / （可选）弹幕命中 | 全开 |
| 记录视频标题 | **仅展示用，非去重键**。是否保存 UID 对应的视频标题（占空间可关，不影响去重） | 关 |
| UID 明细保留 | 是否保留按 UID 的触发明细（用于用户排行） | 开 |

> **已使用数量显示**：数据面板/高级设置处实时显示「**已记录 N 条 / 配额 M 条**」，并用估算字节显示「占用约 X KB」。当接近配额或触发超额策略时给出醒目提示（颜色/文案），点击可直达高级设置调整配额。

> **去重键说明**：去重一律用 **`videoBvid + uid`** 组合，BV 号不可改、全局唯一，是事件的**必存唯一标识**（不可关闭）。标题可能重复/可修改，**绝不能**作为去重键，仅为数据面板明细的友好展示字段。

### 2. 存储与读取

- 新增存储键 `biliban_advanced_settings`，沿用「设置持久化记忆」惯例（参考 `biliban_scan_settings`）。
- 结构：
```js
{
  flushBatch: 50,     // 累积条数刷盘
  flushInterval: 10,  // 秒；缓冲非空才兜底刷盘（空缓冲不写入）
  maxEvents: 50000,     // 缓存配额：events 明细最大条数
  overflowStrategy: 1,  // 超额策略：1=转聚合(默认) 2=淘汰最早 3=清空明细只留聚合
  byteWarnPct: 90,      // 存储字节告警：达 storage.local 配额 X% 即停写+提示
  maxAggregates: 10000, // 聚合配额：aggregates 键数上限
  aggregateStrategy: 1, // 聚合清理策略：1=LRU(默认) 2=保留期内 3=降级 time-bucket
  aggregateRetainDays: 90, // 聚合保留期（天）
  recordComment: true,
  recordVideo: true,
  recordSubtitle: false,  // 弹幕命中（可选）
  saveVideoTitle: false,  // 仅展示字段，非去重键（去重用 bvid+uid，bvid 必存不可关）
  keepUidDetail: true
}
```
- 高级设置页「保存」时写入 storage，采集层每次读取（或会话开始时缓存，改动后刷新）。

### 3. 采集层对接

`content/stats-collector.js` 初始化时 `getAdvancedSettings()` 读一次并缓存：
```js
const cfg = await BilibanStorage.getAdvancedSettings();
this.batchSize = cfg.flushBatch;      // 累计 N 条刷盘
this.flushInterval = cfg.flushInterval; // 或定时刷盘
this.maxEvents = cfg.maxEvents;
```
用户改动设置后，通过 `chrome.storage.onChanged` 通知采集层热更新（或简单地在下次会话生效）。

---

## 十一、实施步骤补充（高级设置）

### M5：高级设置页面
15. 数据面板 Tab 内建「高级」分区（或子 Tab）
16. `manage/manage.html` + `manage/stats.js` 增加高级设置表单（批量刷盘条数/定时、**缓存配额、超额策略、存储字节告警**、事件类型开关等）
17. `lib/storage.js` 增加 `biliban_advanced_settings` 的读写方法
18. 采集层 `stats-collector.js` 读取配置并用于批量刷盘逻辑 + **配额与超额策略**（超配额按所选策略降级）
19. 面板与高级设置显示**已记录条数 / 配额 / 占用字节**，接近配额时高亮
20. 设置保存 + 恢复记忆验证

---

## 十二、补充验收标准

- [ ] 「高级」区域可修改批量刷盘「累积条数」与「定时秒数」
- [ ] 改动后采集层按新策略刷盘（可临时设 1 条/1 秒便于观察）
- [ ] `biliban_advanced_settings` 持久化，重开管理面板恢复
- [ ] 可设置**缓存配额（事件上限）与超额策略**；超配额后按所选策略降级（转聚合/淘汰最早/清空明细）
- [ ] 面板与高级设置**实时显示已记录条数 / 配额 / 占用字节**，接近配额或触发超额策略时有醒目提示
- [ ] 各事件类型开关生效

---

# 第二部分：备份扩展（其他数据备份/恢复）

## 十三、需求拆解

| 需求 | 说明 |
|---|---|
| 备份范围扩展 | 除黑名单（现有 `blacklist.json` / 分块）外，新增备份：**聚合表、事件数据、设置（含扫描设置/缓存设置/高级设置）** |
| 跨设备恢复 | 数据丢失或换设备后，从 GitHub 备份恢复全部设置与使用数据 |
| popup 入口 | 在「云端备份」「社区订阅」两个 tab 之外，**新增第三个 tab「其他数据」** |
| 高级页设置 | 数据备份相关配置：备份仓库名、是否与黑名单同一仓库、数据仓库独立名称 |
| 存放规范 | 数据备份内容放在仓库 **`data/` 目录**下 |
| 云端恢复 | 「其他数据」tab 内提供云端恢复：按仓库链接获取目录内容，按规范路径恢复设置与数据 |

## 十四、方案设计

### 1. 现有机制（复用基础）

- `BilibanGithubSync`（`lib/github.js`）基于 GitHub Repository API，`REPO_NAME = 'BILI-Blacklist'`
- `push(data)` → 推 `blacklist.json`（仓库根）；`pushChunk` → 推分块 JSON；`_putFile(fileName, payload, sha)` → 写任意 JSON 文件（当前在仓库根，`fileName + '.json'`）
- popup 的 GitHub 面板已有「云端备份 / 社区订阅」两个 tab（`github-tab` 切换）

### 2. 数据备份范围（"其他数据"包含）

| 数据 | 存储键（storage.local） | 备份文件 |
|---|---|---|
| 聚合表 | `biliban_block_stats`（含 aggregates/buckets） | `data/stats.json` |
| 事件数据 | `biliban_block_events`（明细） | `data/events.json` |
| 扫描设置 | `biliban_scan_settings` | `data/settings_scan.json` |
| 缓存设置 | `biliban_scan_cache` | `data/cache.json` |
| 高级设置 | `biliban_advanced_settings` | `data/settings_advanced.json` |
| （可选）GitHub 凭证 | token 不入库（安全），仅仓库可见性偏好等 | `data/settings_misc.json` |

> token 属于敏感凭证，**不备份**；仓库名/可见性等非敏感偏好可备份。

### 3. 仓库策略（高级设置可配）

| 设置项 | 说明 | 默认 |
|---|---|---|
| **备份仓库名称** | 数据备份所在仓库名 | `BILI-Blacklist`（沿用） |
| **与黑名单同一仓库** | 数据备份是否与黑名单存同一仓库 | 开 |
| **独立数据仓库名称** | 若"同一仓库"关闭，数据单独存此仓库 | `BILI-Blacklist-Data` |

- **同一仓库**：数据文件放 `data/` 子目录（`_putFile` 支持路径 `data/xxx.json`）
- **独立仓库**：`ensureRepo` 用独立仓库名建仓/写入，文件同样放 `data/` 子目录
- 读取设置并存 `biliban_backup_settings`（沿用设置记忆惯例）

### 4. 存放路径规范（`data/` 目录）

```
仓库根/
├── blacklist.json          ← 现有黑名单（不动）
├── chunk-xxx.json          ← 现有分块（不动）
└── data/                   ← 新增：其他数据
    ├── stats.json          ← 聚合表/统计
    ├── events.json         ← 事件明细
    ├── settings_scan.json  ← 扫描设置
    ├── cache.json          ← 评论缓存
    └── settings_advanced.json ← 高级设置
```

- `_putFile` 改造：支持 `data/` 前缀路径（当前是 `fileName + '.json'`，改为可传入完整路径或统一加 `data/` 前缀）
- 恢复时按此规范路径定位文件

### 5. popup「其他数据」tab UI

- 新增 `github-tab data-tab="other"`：「其他数据」
- 内容：
  - **推送全部**：把聚合表/事件/设置打包推送到 `data/`（可勾选子项）
  - **拉取恢复**：从 `data/` 拉取并写回 storage.local
  - **云端浏览**：列出仓库 `data/` 目录内容（复用 `listCloudChunks` 式目录列举，过滤 `data/` 前缀）
  - 状态提示区
- 复用现有 `github-tab` 切换逻辑 + 按钮样式

### 6. 云端恢复（按仓库链接）

- 输入：`owner/repo` 或完整 GitHub 仓库 URL
- 流程：解析 owner/repo → 列 `data/` 目录 → 按规范路径匹配文件 → 逐文件拉取 → 写回对应 storage 键
- 校验：文件存在性与格式校验（如 `events.json` 必须是数组、`settings_*.json` 必须是对象），失败条目跳过并提示
- 支持"仅恢复设置 / 仅恢复数据 / 全部恢复"选项

### 7. 安全与冲突

- 恢复前**确认弹窗**（覆盖本地数据不可逆）
- 恢复时可选"合并"模式（聚合表/事件按键合并）或"覆盖"模式（默认覆盖）
- token 不随备份传输；恢复仅需仓库读取权限（public 仓库无需 token，private 需 token）

## 十五、实施步骤（备份扩展）

### M6：github.js 数据层扩展
21. `_putFile` 支持 `data/` 前缀路径；新增 `listDataFiles()`（列 `data/` 目录）
22. `BilibanStorage` 增加备份相关读取（聚合表/事件/各设置键打包）与写入（恢复）
23. 新增 `BilibanBackupSettings`（仓库名、是否同仓库、独立仓库名）读写

### M7：popup「其他数据」tab
24. popup.html 增加「其他数据」tab（推送/恢复/云端浏览/状态区）
25. popup.js 实现推送打包、恢复写回、目录列举 UI
26. 复用 token/仓库可见性逻辑（`ensureRepo` 支持独立仓库名）

### M8：高级页备份设置
27. 高级设置表单增加备份仓库配置（仓库名、同一仓库开关、独立仓库名）
28. 保存/恢复记忆 + 与 popup 共享配置

### M9：云端恢复与验证
29. 按仓库链接解析 → 列 `data/` → 按规范路径恢复（覆盖/合并、确认弹窗、校验）
30. 全量语法检查 + ad-hoc 验证（mock fetch/GitHub API）
31. 实机跨设备/清数据恢复验证

---

# 统一里程碑总览

| 里程碑 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| M1 | 数据采集（stats-collector + 埋点 + storage 方法） | - | ✅ 已完成 |
| M2 | 数据面板 UI（Tab + 概览卡 + canvas 容器） | M1 | ✅ 已完成 |
| M3 | 折线图绘制（Canvas 自绘） | M2 | ✅ 已完成 |
| M4 | 打磨（空态、量级上限、验证） | M1-M3 | ✅ 已完成 |
| M5 | 高级设置页面（刷盘/配额/超额/聚合清理） | M1 | ✅ 已完成 |
| M6 | 备份数据层扩展（`data/` 路径、打包读取） | M4/M5 | ✅ 已完成 |
| M7 | popup「其他数据」tab（推送/恢复/浏览） | M6 | ✅ 已完成 |
| M8 | 高级页备份仓库设置 | M6 | ✅ 已完成 |
| M9 | 云端恢复 + 验证 | M6-M8 | ✅ 已完成 |

> 推荐实施顺序：**M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9**（数据采集先行，备份在数据模型稳定后接入）。

---

## 十六、备份扩展验收标准

- [ ] popup 出现第三个 tab「其他数据」，可推送聚合表/事件/设置到 `data/` 目录
- [ ] 仓库中文件按规范路径存放（`data/stats.json`、`data/events.json`、`data/settings_*.json`）
- [ ] 高级设置可配置备份仓库名、是否与黑名单同仓库、独立仓库名；设置持久化
- [ ] 「其他数据」tab 支持按仓库链接（owner/repo 或完整 URL）列出 `data/` 内容
- [ ] 云端恢复按规范路径写回 storage.local（覆盖/合并可选，确认弹窗）
- [ ] 恢复后数据面板/设置与备份前一致（跨设备场景）
- [ ] token 不参与备份；全程 `node --check` 语法通过