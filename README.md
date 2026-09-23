# 油猴脚本

让常用网页更顺手的四个 Tampermonkey 脚本，按需安装即可。

## 安装

1. 在桌面浏览器中安装并启用 Tampermonkey，允许扩展运行用户脚本。
2. 点击下表中的「安装」，在 Tampermonkey 页面确认。
3. 刷新对应网站，开始使用。后续可通过 Tampermonkey 检查更新。

## 脚本列表

| 脚本 | 用途 | 安装 |
| --- | --- | --- |
| **网页浏览体验优化** | 清理 Manga18fx、SimpCity 和 Turbo 嵌入播放器的广告与弹窗 | [安装](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/website-cleanup.user.js) |
| **MXGA** | 在 X 上过滤内容、生成推文分享图、下载视频 | [安装](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js) |
| **M-Team 增强** | 高亮新热种，置灰已访问的种子 | [安装](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/m-team-torrent-enhancer.user.js) |
| **Telegram WebK 下载器** | 单条或批量下载当前聊天的图片、视频和文档 | [安装](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/telegram-webk-media-downloader.user.js) |

### 网页浏览体验优化

- **适用网站**：Manga18fx、SimpCity（含 www）和 Turbo 的 `/embed/` 播放器页面。
- **广告清理**：清理横幅、漂浮广告、广告弹窗与跳转。
- **自动生效**：安装后无需设置；保留 Manga18fx 的年龄确认。

### MXGA

- **适用网站**：桌面 Chrome / Edge 上的 `x.com` 和 `twitter.com`。
- **内容过滤**：按关键词和账号屏蔽内容，也可选中推文文字直接屏蔽短语。
- **分享图**：从推文分享菜单生成图片卡片，方便保存和分享。
- **视频下载**：从分享菜单打开 cobalt 下载，也可连接自己的下载服务。
- **规则管理**：点击页面边缘的 **MXGA** 按钮设置；规则默认保存在本机，可选多端同步，启用后远端规则快照公开可读。
- **使用说明**：请勿与原版 MXGA 扩展同时启用。[查看详细用法](docs/mxga.md)。

### M-Team 增强

- **适用网站**：`kp.m-team.cc`。
- **新热种高亮**：在列表中突出显示新发布的热门种子。
- **已访问置灰**：访问详情后，对应种子行轻度置灰，方便辨认看过的内容。

### Telegram WebK 下载器

- **适用网站**：`web.telegram.org/k/` 和 `webk.telegram.org`。
- **媒体下载**：单条或批量下载当前聊天的图片、视频和文档。
- **筛选范围**：按媒体类型和日期筛选需要下载的内容。
- **本地保存**：在右下角 **WebK Media** 面板选择目录；需要支持目录选择的桌面浏览器。
- **结果确认**：下载完成后查看报告，确认成功与失败项。[查看完整用法](docs/telegram-webk-media-downloader.md)。

## 反馈与开发

遇到问题可在 [Issues](https://github.com/kyangc/tampermonkey_scripts/issues) 提供脚本名称、版本和复现步骤，请勿附带账号凭据或私人内容。参与维护请看 [开发指南](docs/development.md)。

MXGA 衍生自 [foru17/make-x-great-again](https://github.com/foru17/make-x-great-again)，遵循 [AGPL-3.0-or-later](LICENSES/AGPL-3.0.txt)；内置二维码组件遵循 [MIT 许可](LICENSES/qrcode-generator-MIT.txt)。
