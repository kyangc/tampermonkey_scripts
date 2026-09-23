# 开发指南

## 环境与目录

使用 Node.js 24 或更高版本，与 CI 保持一致。同步服务测试需要 `node:sqlite`。

- `scripts/`：四个可直接安装的发布文件。
- `src/userscripts/`：MXGA 和 网页浏览体验优化 的源码，修改后必须重新生成发布文件。
- `services/mxga-sync/`：MXGA 可选同步服务，部署见其 [README](../services/mxga-sync/README.md)。
- `test/`：Node 测试，包含站点规则与同步服务逻辑。
- `tools/`：构建、校验和 Telegram WebK 调试工具。
- `LICENSES/`：衍生代码与内置组件的许可证。

网页浏览体验优化 采用单一 metadata 入口和两个站点模块。每个模块在运行前检查协议、域名与必要的路径，避免一站的清理规则影响另一站。合并后的脚本使用 `unsafeWindow`，两个模块均通过页面 window 安装拦截器。新增站点时同时更新 metadata、运行边界和测试。

M-Team 和 Telegram WebK 下载器直接修改 `scripts/` 中的文件。

## 修改与检查

1. 先阅读目标源码及测试；修改行为时提升对应 metadata 的 `@version`。
2. 更新聚焦测试；变更安装入口时同步修改 README。
3. 修改生成型脚本后运行构建，再运行完整检查：

```bash
npm run build:userscripts
npm run check
```

`check` 依次检查生成文件是否一致、metadata 与 README 安装链接、脚本语法，以及全部 Node 测试。可单独运行 `npm test`、`npm run validate:userscripts` 或 `npm run check:generated` 排查问题。

发布文件名、必需 metadata 和发布流程见 [油猴脚本工程约定](userscript-conventions.md)。推送或创建 PR 后，GitHub Actions 会运行相同检查。

## 浏览器验收

自动化检查不替代 Tampermonkey 与真实站点验收。

- 网页浏览体验优化：分别检查 Manga18fx、SimpCity、Turbo 嵌入页面；确认广告被清理，正常链接、论坛导航、图片和视频播放仍可用，年龄确认仍保留。特别检查 `document-start` 下弹窗拦截是否生效。
- MXGA：见 [浏览器运行时与发布验收](mxga-browser-acceptance.md)；视频兜底背景见 [研究记录](mxga-video-fallback-research.md)。
- Telegram WebK：用少量媒体验证下载、目录权限和结果报告；调试命令见 [下载器文档](telegram-webk-media-downloader.md#本地验证)。
- M-Team：检查种子列表高亮与访问详情后的置灰行为。
