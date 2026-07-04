# Agent Instructions

这个仓库用于维护个人 Tampermonkey / 油猴脚本。新建或修改脚本时，优先遵循本文件；更完整的发布约定见 `docs/userscript-conventions.md`。

## 项目约定

- 可安装脚本只放在 `scripts/` 目录下，文件名使用 `kebab-case.user.js`。
- 每个脚本都通过 GitHub public raw URL 发布和更新。
- 新增脚本后必须在 `README.md` 的脚本列表里增加可点击的 raw 安装链接。
- 修改已有脚本行为时必须提升脚本头部的 `@version`，否则 Tampermonkey 可能不会识别更新。
- 不要提交站点 token、cookie、passkey、账号信息或其他隐私数据。

## Userscript Metadata

每个 `.user.js` 文件必须包含标准 userscript metadata block，并至少包含：

- `@name`
- `@namespace https://github.com/kyangc/tampermonkey_scripts`
- `@version`
- `@description`
- `@author kyangc`
- `@homepageURL https://github.com/kyangc/tampermonkey_scripts`
- `@supportURL https://github.com/kyangc/tampermonkey_scripts/issues`
- `@updateURL`
- `@downloadURL`
- 至少一个 `@match` 或 `@include`

`@updateURL` 和 `@downloadURL` 必须指向当前文件对应的 raw URL：

```text
https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/<relative-path>
```

例如：

```text
scripts/example-script.user.js
https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/example-script.user.js
```

## 开发流程

新增脚本：

1. 在 `scripts/` 下创建 `*.user.js`。
2. 填好 metadata，尤其是 `@version`、`@match`、`@updateURL`、`@downloadURL`。
3. 把可测试的纯逻辑暴露给 Node 测试，或按现有脚本模式组织。
4. 在 `test/` 下补充聚焦的 Node 测试。
5. 在 `README.md` 增加脚本说明和安装链接。
6. 运行 `npm run check`。

修改脚本：

1. 先读目标脚本和对应测试。
2. 修改行为后提升 `@version`。
3. 更新或新增测试覆盖核心逻辑。
4. 运行 `npm run check`。

## 常用命令

```bash
npm run check
npm run validate:userscripts
npm test
node --check scripts/m-team-torrent-enhancer.user.js
```

## 当前脚本

- `scripts/m-team-torrent-enhancer.user.js`：M-Team 种子列表增强，新热种高亮和已访问种子置灰。

这个脚本已有 `test/m-team-torrent-enhancer.test.mjs` 覆盖核心评分、已读记录和样式状态逻辑。
