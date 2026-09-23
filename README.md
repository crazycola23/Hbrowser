# geo-media-browser · GEO 自媒体发布执行面

仓库：`https://github.com/crazycola23/geo-media-browser`（09-22 由 `Hbrowser` 改名而来，仓名 / 目录名 / 包名 / Provider 码现已一致；GEO 侧配置键为 `geo.self-media.browser.*`）。

依据：`../scrm-specs/20-decisions/T-OPEN-33-自媒体账号运营与浏览器发布.md`。

GEO 后端**不跑浏览器**。本服务是它唯一的浏览器执行面：每个自媒体账号一个常驻的
Chromium 持久 profile，负责平台登录保持、页面填写，以及把画面与输入中继给
GEO 页面里的内嵌子窗口。

采集侧的 OneGl 与本服务**互不相干**：OneGl 在它的 `README`「Safety model」里明文
不提供任意导航 / 任意输入 / Cookie 导出，那是它作为共享采集服务的产品边界。
发布需要正好是那一类能力，所以另立一个服务，而不是去推翻它的边界。

---

## 1. 运行

```bash
cp .env.example .env        # 至少要配 GEO_BROWSER_API_KEY
pnpm install                # 或 npm install
npm run install:browsers    # 下载 chromium
npm start                   # 默认 http://127.0.0.1:3310/v1
npm test                    # 不依赖浏览器的冒烟测试
```

需要**有显示环境**（Xvfb 即可）：`headless: false` 是刻意的，内容平台对无头浏览器的
风控明显更严，而"用户能在子窗口里自己点"这件事本身就要求一个真实渲染的页面。

## 2. 合同

GEO 侧配置项 `geo.self-media.browser.contract-version` 必须与 `/v1/contract` 返回的
`contractVersion` **逐字一致**，否则 GEO 匹配不到适配器，任务会一直保持排队。

```
GET    /v1/contract                             能力声明（平台 × 是否实现 × 模式）
GET    /v1/accounts                             账号台账（限速/冷却/是否有 profile）
POST   /v1/accounts            {accountId,platformCode,label}
GET    /v1/accounts/{id}/health                 登录态探测
DELETE /v1/accounts/{id}                        软删：停派发 + 删 profile，保留台账行
POST   /v1/accounts/{id}/sessions {purpose,ttlMinutes}   打开登录/接管会话，建好即导航到该去的页面，返回 bridge 描述
GET    /v1/sessions/{id}                        会话状态（同时回 bridge）
GET    /v1/sessions/{id}/frame                  单帧 PNG（降级通道与首帧）
POST   /v1/sessions/{id}/login-check            人工确认"我登录好了"：导航判定并回写台账
POST   /v1/sessions/{id}/cancel                 关会话（不关 profile）
POST   /v1/publish/jobs                         提交一次填写作业
GET    /v1/publish/jobs/{id}                    作业状态
WS     /v1/sessions/{id}/bridge?token=…         实时帧流 + 输入回注
```

作业状态词表（GEO 侧 `GeoSelfMediaJobOutcome` 逐字对应）：
`publishing | awaiting_manual | verification_required | succeeded | failed | unknown`。

## 3. 这个服务不会做的事

- **不会代替用户点「发布」。** 一期只填不发（`manual_confirm`），填完停在平台发布页。
  最终那一下是用户在子窗口里自己按的（GEO 侧 `N-10` 红线）。
- **不识别、不绕过、不代填任何验证码 / 扫码 / 安全验证。** 遇到就停成
  `verification_required` 并 fail-closed 到账号冷却，等人来处理。
- **不外露凭据。** 响应与日志里没有 cookies、storageState、profile 路径；
  `/bridge` 那条 WebSocket 才是前端能看到的唯一"浏览器"，CDP 端点从不出本进程。
- **不在拿不到确定证据时判成功。** `inspectResult` 认不出文章链接就返回 `unknown`，
  由 GEO 落 `failed(timeout_unknown)`，前端因此不出现重试入口（`N-06`）。
  重复发布出去的稿子收不回来，所以这里宁可不判。

## 4. 凭据与磁盘（上线前必读）

`<dataDir>/profiles/<accountId>/` 里是**活的登录态**，等价于那个平台账号的钥匙。

| 项 | 要求 |
|---|---|
| 目录权限 | `0700`，文件 `0600`（代码已按此创建） |
| 磁盘加密 | 生产必须落在全盘加密卷上；本服务没有对 profile 再做应用层加密 |
| 备份 | 要么整目录冷备份，要么明确接受"掉盘就全部重新扫码" |
| 暴露面 | `/v1` 与 `/bridge` 端口**不得**出公网：拿到即可用任意已登录账号操作真实平台 |
| 回收 | `DELETE /v1/accounts/{id}` 会删 profile，不可逆；何时调用属运维口径（T-OPEN-33 O-5） |

与采集侧 OneGl 的差异要说白：OneGl 用「AES 加密的 storageState + 一次性 profile」，
本服务用「持久 profile 目录」。前者可以随接口生命周期销毁，后者是发布体验
（不必反复扫码）的前提，代价就是上面这张表。

## 5. 限速

`src/config.js` 的 `safety` 段默认值取自 OneGl 的实测保守档，**不是**任何平台公布的
官方上限。可调项：动作间隔、账号内最小间隔、每小时 / 每日次数、连续失败后的冷却时长。

需要人工的两类失败（`verification_required`）一律直接进冷却，不自动重试。

## 6. 已知未验证的部分（重要）

**三个适配器的 DOM 假设都未经实测**：`baijiahao.js` / `toutiao.js` / `douyin.js`。
T-OPEN-33 前置 P-2 的五项事实——登录页/发文页地址、标题与正文的选择器、封面与配图的上传入口、
机房 IP 下的风控反应、登录态能维持多久——目前都没有答案。选择器写成了一张可整体替换的表，
取不到时一律判 `page_changed` 并停住，不猜第二个候选。

分平台说明查证到了哪一步，别把猜的当查证的：

| 平台 | 查证过（搜索直接命中） | 仍是候选、未实测 |
|---|---|---|
| 百家号 | 无 | 登录页、发文页、全部选择器 |
| 今日头条 | 登录页 `mp.toutiao.com/auth/page/login/`、作者后台 `mp.toutiao.com/profile_v4/` | 发文页地址、选择器 |
| 抖音 | 创作者中心 `creator.douyin.com/`、内容上传页 `…/creator-micro/content/upload` | 图文 tab 定位、选择器、笔记 URL 形态 |

未验证前不要接真实账号跑批量发布：那等于拿用户自己的账号去试错。
