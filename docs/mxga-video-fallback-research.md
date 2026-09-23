# MXGA：cobalt 视频下载兜底研究

日期：2026-09-23。状态：研究与接入设计；尚未修改运行代码。

## 结论与实际证据

保留 cobalt 为首选解析器，增加浏览器页面媒体解析器：被动读取 X 正常加载的推文响应，按推文 ID 提取最高码率 MP4，复用现有下载任务。无需另装完整下载脚本，也不增加 NAS 服务。

问题样本：https://x.com/Kai866/status/2102572680155377808

- 之前直接请求 NAS cobalt 返回 `error.api.fetch.empty`；对照推文仍解析成功。
- 本次在 Chrome 登录态观察 X 自己发出的 TweetDetail 请求，HTTP 200。
- 精确匹配 `rest_id=2102572680155377808`，视频媒体 ID 为 `2102572660500951040`，时长 9 秒，`possibly_sensitive=false`。
- 响应包含 HLS 和三档完整 MP4：320×568 / 632000 bps、480×852 / 950000 bps、720×1280 / 2176000 bps。
- 对最高档 MP4 做匿名 1024 字节 Range GET：HTTP 206、Content-Type video/mp4、ftyp 正确，总长度 958579 字节。
- 这证明该样本存在可直接下载的完整文件；不是完整用户脚本下载验收。不能将此前的空 tombstone 直接解释为敏感内容限制，也不能仅凭 404 判断 query ID 过期。

## 代表方案源码对比

以下是源码审阅，不代表这些第三方脚本已经在本机逐一安装验收。

| 项目 | 实现方式与发现 | 对 MXGA 的价值 |
| --- | --- | --- |
| [Twitter Click'n'Save](https://github.com/AlttiRi/twitter-click-and-save/blob/master/twitter-click-and-save.user.js) | 主动请求 TweetResultByRestId；使用页面 CSRF/访客信息，维护 query ID、features 和响应结构；选 MP4 码率。GPL-3.0。 | 可参考媒体归属与选流思路；不将另一套固定接口作为主要兜底。 |
| [ChinaGodMan Twitter Media Downloader](https://github.com/ChinaGodMan/UserScripts/blob/main/twitter-media-downloader/twitter-media-downloader.user.js) | 同样主动调用固定 GraphQL 接口，读本地 Cookie，选择最高码率 MP4。MIT。 | 证明通常不用转码即可取完整 MP4，但接口维护成本仍存在。 |
| [KanashiiWolf Twitter/X Media Downloader](https://greasyfork.org/en/scripts/560318-twitter-x-media-downloader/code) | GraphQL 请求、限流处理、最多 200 项缓存；另用 React Fiber 辅助识别引用推文。MIT。 | 借鉴缓存上限、引用隔离；不引入历史、ZIP、格式转换等整套功能。 |
| [Twitter Media Source](https://gist.github.com/TheAMM/de48c152076fec4c0ba530ad09081f40) | 包装页面 XHR，读取已有 JSON 响应，按推文和媒体 ID 建索引，再选择 MP4；要求页面执行环境。 | 最贴近目标：无需自行维护请求鉴权。独立实现小模块，不直接复制未确认许可的源码。 |

React 内部属性不属于稳定 DOM 接口，不作为主路径。Performance 资源记录只能看到实际请求过的资源，可能只有 HLS 分片，而且容易混入评论视频；不能“挑最后一个 mp4”作为兜底。第三方解析站仍存在访客访问和服务可用性依赖，不作为自动二次上传的目的地。

## 接入设计

### 页面侧采集

- 新建独立 `x-video-source.module.js`，仅采集当前页面正常收到的推文媒体响应。适配 fetch 与 XHR；异常不得影响 X 原请求的返回、回调或异常行为。
- 限定 X 同源、推文相关 GraphQL JSON 响应；排除私信及其他接口，不保存原始 JSON、用户信息或请求头。
- 以 tweet ID 为顶层键、media ID 为子键。支持 TweetWithVisibilityResults 包装；本帖、引用帖、评论分别归档，下载时只接受目标 ID 的媒体。
- 只保留必要的媒体 ID、类型、码率、下载 URL。建议最多 100 条推文、10 分钟 TTL，并限制响应大小、遍历节点数、每帖媒体数量及 URL 长度。页面关闭即释放，不进入 GM 存储或同步。
- 输出格式归一到现有 `{url,type,label,filename}` 下载项。MP4 保留原查询参数，按码率选最大值；animated_gif 保存原 MP4。
- 校验 URL 为 HTTPS、精确主机 `video.twimg.com`、无用户名密码、完整 MP4 路径；不接收页面传来的任意下载目标。

### 启动和沙箱

当前 MXGA 为 `document-idle`，有远程 QR 依赖及 GM 权限，不能假设修改 sandbox 的 fetch 就能观察页面请求。

- 需要小型页面环境采集桥，业务 UI 仍等待 DOM 就绪。采集器和 GM 下载权限分离，页面消息只能提供经过校验的媒体候选；只有用户发起的任务可触发下载。
- 优先验证 `document-start` 与 Tampermonkey 页面环境的注入方式。现有 `@require` 加载可能影响启动时机，必须实测冷加载，不能只改 metadata 就宣称首屏采集可靠。参见 [Tampermonkey 官方文档](https://www.tampermonkey.net/documentation.php#meta:run_at)。
- 桥只传归一后的媒体字段，不传 Cookie、Authorization 或整份接口响应；不向页面暴露 GM API。
- 缓存未命中时短暂等待已在进行的页面加载；仍无数据则提示打开该帖或刷新后重试。播放一下不保证重新获得推文 JSON，不应承诺播放即可修复。
- 首屏可靠性未通过真实 Tampermonkey 验收前，不把主动 GraphQL 调用或 React 遍历作为临时隐藏依赖塞入实现。

### 下载流程

1. 用户点击现有“下载视频”。
2. 配置了 cobalt API：照常调用；解析失败或网络超时后，自动查页面媒体缓存，提示“正在从当前页面获取视频…”。
3. 找到精确归属的 MP4，复用 `downloadCobaltFile` 的 GM.download、取消、文件名和逐个下载逻辑。无需解析/下载二次点击。
4. 用户取消、配置读取失败或配置无效不触发自动兜底；鉴权错误即使兜底成功，也保留简短配置提示，避免掩盖错误。
5. 第一版在解析阶段切换来源。文件传输失败继续现有重试/链接流程；不重新下载整帖，避免已完成的视频重复保存。按文件替换失败的 cobalt tunnel 可后续单独实现，需先建立可靠媒体 ID 映射。
6. 未填写 cobalt 地址：保留当前打开 cobalt 网页的行为。MXGA 无法观察外部网站的解析成败，不将它算作可自动接管的 API 流程；本次不顺带改变这个默认行为。
7. 仅有 HLS、无完整 MP4时明确提示；第一版不加入 ffmpeg.wasm、分片合并、ZIP 或下载历史。

## 代码边界和验收

- `x-video-source.module.js`：纯媒体解析、有限缓存、页面采集桥。
- `x-cobalt-download.module.js`：解析失败后的来源切换；保留取消和已完成项语义。
- MXGA entry / build：采集桥初始化、DOM 就绪边界、版本提升和生成文件。
- 核心测试：精确 tweet/media ID 匹配、引用/评论隔离、多视频及混合媒体、最高码率、URL 校验、缓存淘汰、响应限制、原 fetch/XHR 行为、超时和取消、无配置旧行为。
- 浏览器验收：真实 Tampermonkey 中冷加载与站内跳转均采集成功；问题样本 cobalt 失败后自动下载 MP4；正常 cobalt 不重复下载；脚本更新后的旧标签页有明确刷新行为；下载文件可播放且包含声音。
- 构建及仓库检查通过后，再报告用户脚本发布与真实验收状态。当前只完成方案研究和目标文件的局部读取验证。


## 0.7.3 实施记录

- 已实现页面 fetch/XHR 被动采集、2 MiB 响应限制、100 项/10 分钟缓存、精确推文 ID 匹配和 MP4 选择。
- 通过 unsafeWindow 包装页面 API，采集逻辑与缓存保持在脚本闭包内，不设置页面消息下载入口、不复制鉴权请求头。
- 改为 document-start 采集，界面等 DOMContentLoaded 后初始化。将原先 SHA-256 固定的 qrcode-generator 2.0.4 原文件随包封装，保留 MIT 许可，消除 @require 首次网络下载造成的启动延迟；编码器按需初始化。
- cobalt 解析失败后自动查缓存并下载；鉴权失败但兜底成功时保留配置提示。未配置、配置读取失败、取消和传输失败保持原处理边界。
- `npm run check`：258 项通过。
- Chromium 浏览器测试：fetch/XHR 两种首屏响应均可采集，模拟 cobalt fetch.empty 后真实产生浏览器下载并检查文件内容；正常 cobalt 优先、取消无兜底、无解析浮窗、无页面异常。
- 尚需真实 Tampermonkey 更新后的登录态验收；浏览器测试使用 GM 模拟适配器，不代表扩展沙箱已验收。升级后需刷新 X 页面。
