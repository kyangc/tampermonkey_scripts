# 油猴脚本

[![Userscript checks](https://github.com/kyangc/tampermonkey_scripts/actions/workflows/userscript-checks.yml/badge.svg)](https://github.com/kyangc/tampermonkey_scripts/actions/workflows/userscript-checks.yml)

这是我个人使用的 Tampermonkey / 油猴脚本仓库。

## 脚本列表

### X 推文分享卡片

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js)

在 X 推文原生分享菜单中增加“生成分享图”入口：

- 将作者、账号、正文、发布时间和最多 4 张推文图片排版成独立卡片。
- 单张配图按原始比例完整展示；多张配图使用紧凑网格，并统一添加圆角边框。
- 在弹窗中预览生成结果，并直接复制 PNG 到剪贴板。
- 浏览器不支持图片剪贴板或复制被拒绝时，可下载 PNG 作为兜底。
- 只读取页面已经展示的推文内容，图片在当前浏览器内生成，不调用 X 私有接口，也不会上传推文数据。

当前优先支持普通单条文字/图片推文；视频、投票、复杂引用和长 Thread 只按页面可读取到的正文或封面降级处理。

适用页面：

- `https://x.com/*`
- `https://twitter.com/*`

### Make X Great Again（跨平台 userscript）

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js)

这是对 [foru17/make-x-great-again](https://github.com/foru17/make-x-great-again) 的 AGPL-3.0-or-later userscript 迁移与跨端适配，目标是在一份脚本中同时支持 PC 浏览器和 iOS Safari。许可证全文见 [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt)。

当前功能：

- 定期同步 MXGA 公共名单与官方白名单，匹配全程在本机完成。
- 在 X 首页、搜索、状态页、评论区和个人主页显示名单徽标。
- PC 支持悬停、键盘聚焦和点击；iPhone / iPad 使用点击与底部弹层。
- 可手动本地隐藏账号帖子，5 秒内撤销，也可从脚本面板恢复。
- 自动收录与人工确认条目都会明确标注；当前版本一律只提示，不自动隐藏。
- 使用原名单数组排序和二分查找，避免为大名单额外建立两张内存索引。

安全边界：

- 不上传页面内容、X 身份、命中结果或本地隐藏记录。
- 不调用 X 私有接口，不执行 X 原生静音或拉黑。
- 只作用于 PC / iOS 浏览器里的 `x.com`、`twitter.com`，不能影响原生 X App。
- 请勿与原版 MXGA 浏览器扩展同时启用，以免出现重复徽标和两套隐藏记录。

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

兼容性状态：PC 端已在 Chrome for Testing 148 + 官方 Tampermonkey 5.5.0 中验证 raw 安装、GM 存储、跨域名单同步、服务中断时的缓存降级与恢复、公开个人主页徽标、推文隐藏/恢复与设置持久化；Safari JavaScriptCore 和线上名单解析也已通过。iOS Userscripts 的真实设备内存、安装更新和触控流程仍是正式兼容性验收门槛。真机测试请按 [MXGA iOS / iPadOS 验收清单](docs/mxga-ios-acceptance.md) 执行。

### M-Team 种子列表增强

[点击安装 / 更新脚本](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/m-team-torrent-enhancer.user.js)

功能：

- 新热种高亮：根据发布时间、做种数、下载数、评论数给种子行染色提示。
- 已访问种子置灰：点击进详情页后，在列表里轻度置灰，方便区分已经看过的种子。

适用页面：

- `https://kp.m-team.cc/*`

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
- `test/`：脚本中纯逻辑部分的 Node 测试。
- `tools/`：本仓库的工程校验脚本。
- `LICENSES/`：衍生脚本所需的开源许可证全文。
- `docs/userscript-conventions.md`：油猴脚本发布和更新约定。
- `AGENTS.md`：给新 AI thread / coding agent 的项目操作说明。

## 本地开发

完整检查：

```bash
npm run check
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
