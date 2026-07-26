# Telegram WebK 媒体下载器

这是一个 Tampermonkey userscript，用于把 Telegram WebK 聊天中的图片、视频和文档下载到用户选择的本地目录。

## 安装与迁移

1. 在桌面浏览器中安装 Tampermonkey。
2. 打开 [raw 安装链接](https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/telegram-webk-media-downloader.user.js)。
3. 确认安装后，访问 Telegram WebK。
4. 展开右下角的 `WebK Media` 面板并选择下载目录。

从旧独立仓库安装的 `0.1.0` 版本没有统一仓库的更新地址。旧版用户需要通过上面的链接重新安装一次；从 `0.2.0` 开始，Tampermonkey 会使用脚本中的 `@updateURL` 从本仓库检查更新。

支持的页面：

- `https://web.telegram.org/k/*`
- `https://webk.telegram.org/*`

脚本需要浏览器提供 File System Access API；如果页面环境没有 `showDirectoryPicker`，面板会提示当前浏览器无法选择下载目录。

## 功能范围

- 下载图片、视频和文档类附件，不导出聊天正文。
- 通过消息上的悬停按钮下载单条消息中的媒体。
- 从面板扫描当前聊天，并把结果加入独立的下载队列。
- 按图片、视频和文档类型筛选，也可设置停止扫描的最早日期；筛选条件在任务入队时固定。
- 扫描过程中检测聊天切换，避免把不同聊天的媒体写入同一目录。
- 根据规划文件名和文件大小跳过已存在文件。
- 下载结束时区分全部成功、包含失败项和任务失败，详细结果写入下载报告。
- 记住已授权的目录句柄；浏览器撤销权限后会要求重新授权。

## 输出目录

```text
<所选目录>/
  <聊天标题>__peer-<peer id>/
    images/
    videos/
    documents/
    _manifest.json
    _download-report.json
```

下载文件名包含本地发送时间、消息 ID、可用时的相册分组 ID、媒体类型和原文件名或媒体 ID：

```text
YYYYMMDD_HHmmss_mid-<message-id>[_gid-<group-id>][_idx-<n>]_<type>_<name>.<ext>
```

## 隐私与兼容性边界

- 媒体直接写入用户选择的本地目录，脚本不提供额外的上传或同步服务。
- 目录句柄保存在浏览器本地的 IndexedDB 中，面板位置保存在 localStorage 中。
- `Copy Debug Report` 生成的报告不包含聊天正文，并会遮蔽标题、名称、文件名、聊天 ID 和 peer ID。
- 脚本依赖 Telegram WebK 的 `appDownloadManager`、聊天选择状态等内部对象。Telegram 更新 WebK 后，即使自动化测试仍通过，也应做一次小范围真实下载验证。

## 本地验证

统一仓库的完整检查会校验 userscript metadata、所有脚本语法和全部 Node 测试：

```bash
npm run check
```

本地检查需要 Node.js 24 或更高版本，与 CI 使用的版本一致。

下载器测试覆盖路径规划、媒体归一化、已存在文件处理、manifest 写入、WebK 下载器回退、聊天切换保护、扫描与下载队列，以及生产运行时的调试接口边界。

## CDP 调试

使用独立调试配置启动 Chrome：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tg-webk-debug-profile \
  --no-first-run \
  --no-default-browser-check \
  https://web.telegram.org/k/
```

登录并打开测试聊天后运行：

```bash
npm run debug:webk
npm run debug:webk:single
npm run debug:webk:batch-visible
```

`debug:webk` 采集只读诊断信息。两个 smoke 模式会在页面中临时安装虚拟目录，验证 Telegram WebK 的消息解析和下载路径，不会把媒体写入磁盘。也可以用 `CDP_PORT=<端口>` 指定其他远程调试端口。
