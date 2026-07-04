# 油猴脚本工程约定

本仓库统一使用 GitHub public raw URL 发布和更新 Tampermonkey 脚本。

## 发布规则

- 所有可安装脚本放在 `scripts/` 目录下，文件名使用 `kebab-case.user.js`。
- 每个脚本都必须通过 GitHub raw URL 安装，README 中的安装入口也必须指向 raw URL。
- 每次修改脚本行为后，都必须提升 `@version`，否则 Tampermonkey 可能不会识别为新版本。
- 不提交站点 token、cookie、私有 passkey 或其他隐私数据。

## 必需元信息

每个 `.user.js` 文件头部都必须包含以下元信息：

```js
// ==UserScript==
// @name         Example Script
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.0
// @description  Short description.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/example-script.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/example-script.user.js
// @match        https://example.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
```

`@updateURL` 和 `@downloadURL` 必须和脚本在仓库里的相对路径一致。例如：

- 文件：`scripts/m-team-torrent-enhancer.user.js`
- raw URL：`https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/m-team-torrent-enhancer.user.js`

## 新增脚本流程

1. 在 `scripts/` 下创建新的 `*.user.js` 文件。
2. 填好必需元信息，尤其是 `@version`、`@match`、`@updateURL` 和 `@downloadURL`。
3. 尽量把可测试的纯逻辑拆出来，并在 `test/` 下补充 Node 测试。
4. 在 README 的脚本列表里增加安装链接。
5. 本地运行：

```bash
npm run check
```

6. 提交并推送到 `main`。
7. 在浏览器里点击 README 的 raw 安装链接确认 Tampermonkey 能正常安装或更新。

## 更新已有脚本流程

1. 修改脚本。
2. 提升脚本头部的 `@version`。
3. 更新或补充测试。
4. 本地运行：

```bash
npm run check
```

5. 提交并推送到 `main`。

## 本地校验

运行：

```bash
npm run validate:userscripts
```

这个命令会检查：

- `scripts/` 下存在至少一个 `.user.js` 文件。
- 文件名符合 `kebab-case.user.js`。
- 必需元信息齐全。
- `@version` 符合 `x.y.z` 形式。
- `@namespace`、`@homepageURL`、`@supportURL` 使用本仓库地址。
- `@updateURL` 和 `@downloadURL` 指向当前文件对应的 GitHub raw URL。
- 至少配置了一个 `@match` 或 `@include`。
