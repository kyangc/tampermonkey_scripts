# MXGA 浏览器运行时与发布验收

这份文档把三类证据分开记录，避免把纯逻辑测试或合成页面烟测误当成真实 X / Tampermonkey 验收：

1. Node 纯逻辑与构建门禁；
2. 真实浏览器内核中的合成 X DOM 运行时烟测；
3. 官方 Tampermonkey 从 GitHub Raw 安装后，在真实 `x.com` 页面上的发布验收。

## 2026-07-31 Chromium 运行时烟测

测试对象：

- MXGA `0.2.2`
- commit `5b209a0a58296ac46d29cd1c8e9ecca910840bf7`
- 与 GitHub Raw SHA-256 一致的生成脚本
- headed Google Chrome，由 Playwright CLI 驱动
- 合成的公开推文 DOM；不使用 X 登录态、Cookie 或私人时间线

已观察结果：

- 连续触发分享按钮后，菜单中仍只有一个“生成分享图”入口。
- 文字推文能生成预览，弹窗中的复制与下载按钮进入可用状态。
- 使用宽高比 `20:1` 的合成长图时，实际 Canvas 为 `490 × 8192`，共 `4,014,080` 像素，未超过 800 万像素和 8192 最大边预算。
- 对图片请求增加 2.5 秒延迟后，在生成过程中关闭弹窗，观测到进行中的 fetch 被 abort；关闭后弹窗数量为 0，菜单入口数量仍为 1。

这个烟测证明当前生成文件能在真实 Chromium 的 DOM、Canvas、Blob、Shadow DOM 和 AbortController 运行时中完成关键流程。它不证明 Tampermonkey 的 Raw 安装、真实 X DOM 兼容性或 iOS 内存稳定性。

## 尚未完成的正式门槛

- [ ] 官方 Tampermonkey 从 README 的 GitHub Raw 链接安装或更新到当前版本。
- [ ] 在真实公开 `x.com` 推文上确认菜单只注入一次。
- [ ] 文字、单图、极长单图、四图、视频封面和引用推文均能生成可读预览。
- [ ] 生成过程中关闭弹窗或立即生成另一张，旧任务不会继续显示结果。
- [ ] 服务中断时仍使用最后一次完整名单快照，界面显示的名单版本与实际条目一致。
- [ ] 控制台没有由 MXGA 引起的未处理异常。

通过时记录 Chrome、Tampermonkey、脚本版本和公开测试 URL；不要保存 Cookie、Authorization、passkey、X 登录态或私人时间线截图。

## iOS / iPadOS

iOS Userscripts 的安装更新、首次名单同步内存、触控和分享图仍必须按
[MXGA iOS / iPadOS 真机验收清单](mxga-ios-acceptance.md)执行，桌面 Chromium 结果不能替代真机。
