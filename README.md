# 油猴脚本

这是我个人使用的 Tampermonkey / 油猴脚本仓库。

## 脚本列表

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
- `docs/userscript-conventions.md`：油猴脚本发布和更新约定。
- `AGENTS.md`：给新 AI thread / coding agent 的项目操作说明。

## 本地开发

完整检查：

```bash
npm run check
```

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
