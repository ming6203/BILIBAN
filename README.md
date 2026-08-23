# BILIBAN - B站用户屏蔽

Chrome 浏览器插件，用于屏蔽 B 站指定用户的评论、视频推荐、搜索结果和动态。

## 功能

- **分组管理**：将屏蔽用户按组分类，自由命名，独立开关
- **分块整理**：将分组切割整理为块，为相关分组进一步分类
- **评论区屏蔽**：自动隐藏被屏蔽用户的评论和回复
- **视频卡片屏蔽**：首页、搜索页、侧边推荐中隐藏被屏蔽用户的视频
- **搜索结果屏蔽**：搜索页过滤被屏蔽用户的内容
- **弹幕/动态过滤**：API 层面拦截，渲染前过滤
- **一键屏蔽**：视频卡片和评论区旁注入屏蔽按钮，点击选择分组
- **强力屏蔽模式**：高频扫描，增强屏蔽覆盖
- **主页黑名单提醒**：打开被拉黑用户的空间主页时，自动弹窗提醒并显示所在分组
- **导入导出**：本地 JSON 格式导入导出黑名单
- **GitHub 同步**：通过 Gist 备份和同步黑名单
- **社区订阅**：从公开仓库拉取共享黑名单

## 安装

1. 下载本仓库代码（Clone 或 Download ZIP）
2. 打开 Chrome，访问 chrome://extensions/
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本仓库目录

## 使用

1. 点击浏览器工具栏的图标打开插件面板
2. 创建分组 → 添加 UID → 开启分组
3. 浏览 B 站时，被屏蔽用户的内容自动隐藏
4. 视频卡片和评论区旁出现「屏蔽」按钮，可快速添加到分组

Github云同步-使用token自动创建推送到云端，根据分块同步和拉取

## 文件结构

```
├── manifest.json          # 插件配置
├── background/
│   └── service-worker.js  # 后台服务
├── content/
│   ├── bilibili.js        # 主内容脚本（DOM 屏蔽 + 按钮注入）
│   ├── interceptor.js     # API 拦截器（请求过滤）
│   ├── infinite-scroll.js # 强力屏蔽模式开关
│   └── blocker.css        # 样式
├── lib/
│   ├── storage.js         # 数据存储层
│   └── github.js          # GitHub Gist 同步
├── popup/
│   ├── popup.html         # 弹窗页面
│   ├── popup.css          # 弹窗样式
│   └── popup.js           # 弹窗逻辑
└── icons/                 # 图标
```
``


## 兼容性

本插件已适配以下 B 站增强扩展，可同时使用：

- **[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)**：自动检测 Shadow DOM 并在其内部注入屏蔽按钮和执行屏蔽逻辑，暗色模式下按钮样式自动适配
- **[Bilibili-Gate](https://github.com/nichuanfang/Bilibili-Gate)**：适配其视频卡片结构（.bilibili-gate-video-grid），屏蔽按钮插入到 UP 主名字旁

如遇到其他扩展的兼容问题，欢迎提 Issue 反馈。
## 许可

MIT License