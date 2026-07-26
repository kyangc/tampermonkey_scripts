# 油猴脚本

[![Userscript checks](https://github.com/kyangc/tampermonkey_scripts/actions/workflows/userscript-checks.yml/badge.svg)](https://github.com/kyangc/tampermonkey_scripts/actions/workflows/userscript-checks.yml)

这是我个人使用的 Tampermonkey / 油猴脚本仓库。

## 脚本列表

### AI Agent Book 读书笔记

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/ai-agent-book-reading-notes.user.js)

[点击安装 / 更新舒适阅读 Stylus 样式](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/styles/ai-agent-book-comfort-reading.user.css)

为《AI Agents in Depth》电子书增加本地优先的阅读批注能力：

- 选中正文后通过浮动工具栏添加淡色画笔高亮、手绘划线或带观点的手工批注。
- 使用位置、原文、上下文和段落结构组合锚点；可自动适应空白、标点和部分措辞变化。
- 有歧义的新版原文会等待手动确认，也可重新选择文字完成关联，并保留旧原文历史。
- 在右下角的读书笔记面板中按本页或全书查看、定位、编辑和删除记录。
- 默认只保存在 Tampermonkey 本地；也可连接自建的 Cloudflare Worker + D1，在不同设备间增量同步。
- 云同步采用设备独立凭证和 AES-GCM 端到端加密；Worker 与 D1 只接触密文。
- 新设备必须通过可信设备生成的五分钟一次性配对码加入，可在同步设置中单独撤销。
- 可按全书章节顺序导出为 Markdown 或独立 HTML 网页。

适用页面：

- `https://bojieli.github.io/ai-agent-book/`
- `https://bojieli.github.io/ai-agent-book/book/*`

云同步后端位于 [`services/reading-notes-sync`](services/reading-notes-sync)，部署步骤和安全边界见其中的 [README](services/reading-notes-sync/README.md)。未配置同步服务时，脚本不会发出任何笔记网络请求。

当前个人同步服务地址：

```text
https://reading-notes-sync.1109.workers.dev
```

### X 推文分享卡片（独立兼容版）

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js)

分享卡片能力已经内置在 Make X Great Again 0.2.0 及以上版本。只需要分享图、不需要名单标记与本地隐藏时，可以继续安装这个独立兼容版；已经启用 MXGA 时无需再启用它。

在 X 推文原生分享菜单中增加“生成分享图”入口：

- 将作者、账号、正文、发布时间和最多 4 张推文图片排版成独立卡片。
- 单张配图按原始比例完整展示；多张配图参照 X 使用双列、左大右双格或 2×2 网格，并统一添加圆角边框。
- 视频推文使用页面可见的封面图并叠加播放标；认证作者会保留认证徽章。
- 引用推文和对话页中的回复会以嵌套推文卡片展示可见的作者、正文和配图。
- 正文中的 @提及、#话题和完整链接使用 X 品牌蓝突出显示；长链接按类似 CSS `text-wrap` 的方式利用剩余行宽。
- 海报底部在内容卡片之外展示原文链接和本地生成的二维码，扫码即可打开对应推文。
- 在弹窗中预览生成结果，并直接复制 PNG 到剪贴板。
- 浏览器不支持图片剪贴板或复制被拒绝时，可下载 PNG 作为兜底。
- 只读取页面已经展示的推文内容，图片在当前浏览器内生成，不调用 X 私有接口，也不会上传推文数据。

当前优先支持普通文字、图片、视频、引用推文和对话页回复；投票和更深层 Thread 只按页面可可靠读取到的内容降级处理。

二维码编码使用 MIT 许可的 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)，依赖版本和 SHA-256 完整性校验均固定在脚本 metadata 中。

适用页面：

- `https://x.com/*`
- `https://twitter.com/*`

### Make X Great Again（跨平台 userscript）

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js)

这是对 [foru17/make-x-great-again](https://github.com/foru17/make-x-great-again) 的 AGPL-3.0-or-later userscript 迁移与跨端适配，目标是在一份脚本中同时支持 PC 浏览器和 iOS Safari。许可证全文见 [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt)。

当前功能：

- 定期同步 MXGA 公共名单与官方白名单，匹配全程在本机完成。
- 在 X 首页、搜索、状态页、评论区和个人主页显示名单徽标。
- 在 X 原生分享菜单中增加“生成分享图”，支持作者、正文、配图、视频封面、引用/回复、原文二维码以及复制/下载 PNG。
- PC 支持悬停、键盘聚焦和点击；iPhone / iPad 使用点击与底部弹层。
- 默认隐藏人工确认账号的列表项与推文，可在脚本面板临时关闭；自动收录条目仍只提示。
- 可手动本地隐藏账号内容，5 秒内撤销，也可从脚本面板恢复；手动隐藏记录不受自动隐藏开关影响。
- 设置面板打开时，点击面板外空白区域会关闭面板，不会触发下方 X 页面。
- 使用原名单数组排序和二分查找，避免为大名单额外建立两张内存索引。

安全边界：

- 不上传页面内容、X 身份、命中结果或本地隐藏记录。
- 不调用 X 私有接口，不执行 X 原生静音或拉黑。
- 分享图只读取页面已展示的推文内容；图片通过 `pbs.twimg.com` 在本地加载并在 Canvas 中生成，不上传推文数据。
- 只作用于 PC / iOS 浏览器里的 `x.com`、`twitter.com`，不能影响原生 X App。
- 请勿与原版 MXGA 浏览器扩展同时启用，以免出现重复徽标和两套隐藏记录。
- MXGA 已内置分享卡片；无需同时启用上面的独立兼容版。若两者都为新版本，页面级保护也只会启动一份分享卡片运行时。

PC 安装：

1. 安装 Tampermonkey。
2. Chrome 138 及以上版本打开 Tampermonkey 的扩展详情页，启用“允许运行用户脚本”；也可按 [Tampermonkey 官方说明](https://www.tampermonkey.net/faq.php?locale=en&q=Q209)启用浏览器开发者模式。
3. 打开上面的 raw 安装链接并确认安装。
4. 访问 `https://x.com/`，右下角出现 `MXGA` 控制按钮。

iOS / iPadOS 安装：

1. 安装并打开 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)。
2. 在“设置 → Safari → 扩展 → Userscripts”中启用扩展，并允许访问 `x.com`。
3. 在 Userscripts App 中设置脚本目录，然后在 Safari 的 Userscripts 界面选择 `New Remote`。
4. 粘贴上面的 raw 安装链接，保存并启用脚本。
5. 打开 `https://x.com/`；首次同步约 7 MB 的公共名单，需要等待片刻。

兼容性状态：PC 端已在 Chrome for Testing 148 + 官方 Tampermonkey 5.5.0 中验证 raw 安装、GM 存储、跨域名单同步、服务中断时的缓存降级与恢复、公开个人主页徽标、推文隐藏/恢复与设置持久化；Safari JavaScriptCore 和线上名单解析也已通过。分享卡片合并部分沿用独立版的纯逻辑回归测试，但合并后的 Raw 文件仍需补一次真实浏览器验收。iOS Userscripts 的真实设备内存、安装更新、分享图生成和触控流程仍是正式兼容性验收门槛。真机测试请按 [MXGA iOS / iPadOS 验收清单](docs/mxga-ios-acceptance.md) 执行。

### M-Team 种子列表增强

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/m-team-torrent-enhancer.user.js)

功能：

- 新热种高亮：根据发布时间、做种数、下载数、评论数给种子行染色提示。
- 已访问种子置灰：点击进详情页后，在列表里轻度置灰，方便区分已经看过的种子。

适用页面：

- `https://kp.m-team.cc/*`

### Telegram WebK 媒体下载器

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/telegram-webk-media-downloader.user.js)

把 Telegram WebK 当前聊天中的图片、视频和文档下载到用户选择的本地目录：

- 支持悬停后逐条下载，也可扫描当前聊天并批量加入下载队列。
- 可按媒体类型和日期筛选；筛选条件在任务入队时固定，切换聊天时会终止不安全的批量扫描。
- 按聊天和资源类型整理文件，并写入 manifest 与本次下载报告。
- 根据规划文件名和文件大小跳过已存在文件。
- 下载结束时会明确区分全部成功、包含失败项和任务失败。
- 目录句柄只保存在浏览器本地，调试报告不包含聊天正文，并会遮蔽标题、名称和聊天 ID。

适用页面：

- `https://web.telegram.org/k/*`
- `https://webk.telegram.org/*`

脚本依赖 File System Access API 和 Telegram WebK 的内部下载对象。首次从旧独立仓库版本迁移时，请通过上面的新链接重新安装一次；后续版本会从本仓库自动检查更新。完整用法、输出目录和调试说明见 [Telegram WebK 媒体下载器文档](docs/telegram-webk-media-downloader.md)。

### SimpCity 广告清理

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/simpcity-ad-cleaner.user.js)

功能：

- 拦截 SimpCity 上已知广告域名触发的点击弹窗和跳转。
- 隐藏首页和动态插入的广告 banner / 推广块。

适用页面：

- `https://simpcity.cr/*`
- `https://www.simpcity.cr/*`
- `https://turbo.cr/embed/*`
- `https://www.turbo.cr/embed/*`

### Manga18fx 广告清理

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/manga18fx-ad-cleaner.user.js)

功能：

- 隐藏 Manga18fx 首页、详情页和章节页里的 `kadx` banner 广告位。
- 清理外部广告脚本插入的漂浮视频广告、点击遮罩和追踪 iframe。
- 关闭反广告拦截提示弹窗，但保留年龄确认弹窗。

适用页面：

- `https://manga18fx.com/*`
- `https://www.manga18fx.com/*`

安装方式：

1. 浏览器安装 Tampermonkey 扩展。
2. 打开上面的安装链接。
3. 在 Tampermonkey 弹出的页面里确认安装。

后续更新：

- 从上面的 raw 链接安装后，Tampermonkey 会根据脚本里的 `@updateURL` 检查更新。
- 每次修改脚本后需要提升 `@version`，浏览器端才会识别为新版本。

## 仓库结构

- `scripts/`：Tampermonkey `.user.js` 脚本。
- `src/userscripts/`：共享 userscript 入口和运行时模块源码。
- `test/`：脚本中纯逻辑部分的 Node 测试。
- `tools/`：userscript 生成与工程校验脚本。
- `LICENSES/`：衍生脚本所需的开源许可证全文。
- `docs/userscript-conventions.md`：油猴脚本发布和更新约定。
- `AGENTS.md`：给新 AI thread / coding agent 的项目操作说明。

## 本地开发

需要 Node.js 24 或更高版本；CI 使用 Node.js 24。Worker 测试依赖该版本提供的 `node:sqlite`。

完整检查：

```bash
npm run check
```

修改 `src/userscripts/` 后，先生成可发布脚本：

```bash
npm run build:userscripts
```

推送到 `main` 或创建 Pull Request 后，[GitHub Actions](https://github.com/kyangc/tampermonkey_scripts/actions/workflows/userscript-checks.yml) 会在只读权限下自动运行同一套检查；检查通过不等于 iOS 真机验收通过。

校验油猴脚本发布元信息：

```bash
npm run validate:userscripts
```

运行测试：

```bash
npm test
```

检查脚本语法：

```bash
node --check scripts/m-team-torrent-enhancer.user.js
```

## 备注

- 起新 AI thread 做脚本时，可以让它先读 `AGENTS.md` 和 `docs/userscript-conventions.md`。
- 新增或更新脚本前，先看 [油猴脚本工程约定](docs/userscript-conventions.md)。
- 脚本文件名统一使用 `kebab-case.user.js`。
- 不要提交站点 token、cookie 或其他隐私数据。
