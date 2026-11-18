<p align="center">
  <img src="assets/logo.png" alt="codexplus logo" width="160" />
</p>

# codexplus

通过 C/S 架构集中保存 Codex / ChatGPT 凭证，在用户自己的电脑上用 TUI 添加和切换账号。仓库是 npm workspaces 组成的 monorepo，提供两个命令：

- **服务端**（`codexplus-server`，包 `packages/app-server`）保存账户凭证，读写当前 Codex 登录文件，查询账号邮箱，执行文件导入、浏览器登录和进程检测，通过仅监听 `127.0.0.1` 的 JSON-RPC 2.0 接口提供操作。
- **客户端**（`codexplus`，包 `packages/tui`）是本机 TUI，负责视图、菜单、输入和确认，通过 API 请求服务端保存或切换账号。客户端不读写凭证文件，也不接收账号 token；当前登录路径由服务端的 `CODEX_HOME` 决定，默认 `~/.codex/auth.json`。服务端只执行登录和凭证管理，不运行 Codex 任务。

## 安装

需要 Node.js 22.22.2+（22.x）、24.15.0+（24.x）或 26+。

```sh
npm install --global @weiguangchao/codexplus@latest
codexplus
```

直接使用时安装客户端即可，其中包含本机服务端。临时使用可运行 `npx @weiguangchao/codexplus@latest`，升级时重新执行全局安装命令。独立运行服务端时使用 `npm install --global @weiguangchao/codexplus-server@latest`，不需要 TUI 依赖。npm 安装需要先完成下文的首次发布。

从源码安装时，在仓库根目录执行：

```sh
npm ci
npm run build
npm install --global ./packages/tui
```

源码全局安装会链接到仓库目录，因此需要保留仓库并在更新后重新运行 `npm run build`；需要独立服务端命令时再运行 `npm install --global ./packages/app-server`。

开发时使用 `npm run dev`（客户端）和 `npm run dev:server`（独立服务端），两者直接运行源码，将数据放在项目根目录已忽略的 `.codexplus/` 中。客户端开发入口在代码中注入该目录，独立服务端仍通过 `--home .codexplus` 指定；TUI 始终启动自己的服务端。

需要使用日常账号数据运行本地开发版时，在仓库根目录执行：

```sh
npm run dev:local
```

该命令直接运行本地源码，无需构建或全局安装，使用默认数据目录 `~/.codexplus`，与全局安装版共享账号和配置。修改代码后重新运行即可生效。

## 命令

```sh
codexplus
codexplus --help
codexplus -h
```

`codexplus` 在交互式终端中打开菜单，查看状态、账号列表和切换账号均通过菜单完成。`--help` 和 `-h` 显示同一份帮助，无需交互式终端，显示后直接退出，不启动服务端。其他参数和子命令均会报错并以非零状态退出，包括旧的 `status`、`list`、`switch`、`serve`、`--home` 和 `--port`。

TUI 自带本机服务端，数据目录固定为 `~/.codexplus`；当前 Codex 登录文件使用 `$CODEX_HOME/auth.json`，未设置时为 `~/.codex/auth.json`。例如：

```sh
CODEX_HOME=~/my-codex codexplus
```

独立服务端保留自己的命令和参数，供直接 API 调用，TUI 不连接它：

```sh
codexplus-server [--port 47831] [--home 目录]
codexplus-server log [--limit 条数] [--home 目录]
```

服务端监听端口默认 `47831`，可用 `--port` 指定。服务端的 `--home <目录>` 或 `--home=<目录>` 指定数据目录，默认 `~/.codexplus`，支持绝对路径、相对路径和 `~/`。运行 `codexplus-server --help` 查看帮助。

TUI 和操作提示中的邮箱统一脱敏：账户名保留前后各两位，中间显示 `***`；不足五位时全部隐藏；邮件服务商只保留首字符，其余域名显示为 `***`。例如 `guest66@163.example` 显示为 `gu***66@1***`。位置与连接中的路径也会隐藏用户目录名。

检测到 Codex 进程仍在运行时，按顺序提供「取消，先退出 Codex」「仍然切换」「仍然切换并重启 codex server」，默认取消。最后一项在切换成功后，由服务端使用当前登录文件所属的 `CODEX_HOME` 执行官方命令 `codex app-server daemon restart`，重启 Codex 托管后台服务；独立启动的会话仍需手动重启。需要支持该命令的官方 Codex CLI。重启失败会明确提示账号已切换，并提醒手动重启，不回滚已完成的切换。「更新本机登录」保留原来的取消和继续两项。

## 本机使用

直接运行 `codexplus` 时，每个客户端进程自带服务端，监听 `127.0.0.1` 的随机端口，通过 HTTP 接口访问数据，退出时关闭。自带服务端沿用仅存在内存的本机会话令牌，不保存客户端授权记录。保留客户端、服务端分离的 C/S 架构，客户端与服务端之间的数据通信在本机完成，不需要配对。

TUI 不接受服务端端口或 URL，也不读取旧连接配置；服务端不提供监听地址或 TLS 配置。

服务端首次读取登录信息时，将自身数据目录中旧版 `client.json` 标记为 `local` 的同步基线迁入 `login.json`，并将旧文件改为只含版本号 4，清除旧连接地址、客户端令牌和配对信息。旧远程连接不会被访问。`server-access.json` 和 `local-codes/` 不再读取或写入，已有文件可以自行删除。原有 `config.json` 和账户凭证继续使用；旧的 `credentials/codex-<邮箱>.json` 在首次读取或保存时自动迁移到 `credentials/codex-<邮箱>/auth.json`，内容和同步摘要不变。新旧文件同时存在时以新路径为准，并移除旧文件。

## 菜单

首页突出当前账号、同步状态和账号库数量，按使用顺序提供切换、添加、账户信息和重置卡；删除账号放在「账号管理」下方。数据目录、实际 Codex 登录文件和回环服务地址集中在「位置与连接」中查看。方向键移动，回车确认，Esc 返回上一级（在主菜单中退出），Ctrl+C 随时取消。首页可按选项前的字母定位，再回车执行。

选择「重启 codex server」（快捷键 `c`）可单独重启当前登录目录的 Codex 托管后台服务，无需切换账号或登录。确认页默认取消；确认重启后显示进度和结果，随后返回主菜单。使用与切换账号后重启相同的官方命令，独立启动的会话仍需手动重启。

### Antigravity CLI

在主菜单选择「Antigravity CLI」（快捷键 `g`），可以保存当前 `agy` 登录、从其他 `antigravity-oauth-token` 文件导入，或在已保存的账号之间切换。适用于 `agy` 使用文件存储的会话，例如走文件回退的 SSH 会话。菜单展示服务端用户的 `~/.gemini/antigravity-cli/antigravity-oauth-token`。若 `agy` 使用系统钥匙串，这个文件无法控制该会话的账号。存储行为见 [Antigravity 认证文档](https://antigravity.google/docs/install/?tab=cli)。

保存和导入保留原始凭据文件，包括 `agy` 刷新登录需要的字段。账号标签来自文件中的邮箱，脱敏显示相同时会补充用于区分的前缀。每个账号的副本放在服务端 `<home>/credentials/antigravity/agy-<邮箱>/antigravity-oauth-token`，依赖文件权限保护。同一账号的内容变化时，覆盖副本前会要求确认。切换前请退出正在运行的 `agy`，切换后以文件模式启动。切换到另一个账号时，可以先保存尚未入库或已经变化的当前凭据。

切换、删除和重置卡的账号列表支持直接输入显示的脱敏邮箱筛选，退格修改、Ctrl+U 清空；Home/End 到列表首尾，PageUp/PageDown 按当前显示页翻页。列表随终端尺寸调整，底部显示当前位置。短终端优先保留当前账号和额度数字，长说明、完整路径可按 Ctrl+O 或 F1 查看；非筛选菜单也支持 ?。方向键滚动，Enter 或 Esc 返回选项，再按 Esc 返回上一级。浏览器登录的长链接也可按 Ctrl+O 完整查看，等待状态始终显示，Esc 先返回登录页，再按 Esc 取消。不可用选项会显示原因，回车不会执行。

长路径按终端宽度独立显示或保留首尾省略。路径输入框随光标横向滚动，`‹`、`›` 表示左右还有未显示的内容；完整路径仍用于编辑、校验和上传。支持方向键、Home/End、退格、Delete 和 Ctrl+U 清除光标左侧内容。

- **切换账号**：从服务端已保存的邮箱列表中选择，请求服务端将对应凭证写入服务端管理的当前登录文件，凭证内容不会传到 TUI。当前账号标记为「● 当前」且不可选。当前登录未保存或本机有更新时，会先询问是否保存再切换；与服务端版本不一致时显示两边的刷新时间，可以选择先用本机登录覆盖服务端、不保存直接切换或返回；只有摘要基线与刷新时间共同表明服务端较新时不提醒保存。写入前请求服务端检查 Codex 进程；检测到时列出进程名和 PID，再次确认，默认取消，只有明确选择继续才切换。切换不再次请求 ChatGPT 账号接口，但需要连接服务端；成功后退出。
- **添加账号**：可以通过浏览器登录、直接保存当前 Codex 登录（实际路径可在「位置与连接」查看），也可以手动输入其他 `auth.json` 路径，支持绝对路径、相对路径、`~/`，以及拖入终端时带引号或 `\ ` 转义空格的路径。按回车确认时会请求服务端检查文件是否存在、是否包含 `tokens.access_token`，有问题直接在输入框下方提示。当前 Codex 登录与服务端保存的凭证一致时，不会重复上传。客户端只提交文件路径，由服务端读取、校验并过滤内容，再使用 `tokens.access_token` 查询邮箱并保存为 `credentials/codex-<邮箱>/auth.json`，查询时显示加载动画，不修改源文件。同一邮箱再次添加须匹配基线摘要，冲突时显示两边刷新时间并确认后重试。上传内容与服务端一致时不写盘，提示「已是最新，无需更新」；文件导入完成后默认「完成」回到主菜单，也可选择「立即切换」。

「浏览器登录」要求服务端运行环境已安装官方 Codex CLI，且 `codex` 在其 `PATH` 中。服务端通过 `codex app-server` 的 `account/login/start`（`type: "chatgpt"`）复用官方浏览器认证，打开系统浏览器，等待本机回调；自动打开失败时可手动打开终端显示的链接。登录进程使用独立临时 `CODEX_HOME` 和文件凭证存储，完成后读取凭证到内存、退出进程并删除临时目录，随后由服务端保存到凭证库。TUI 只获取登录链接、进度和本次登录标识，保存与重试均提交该标识。通过 SSH 使用时，需要让浏览器能够访问运行服务端的电脑上的回调端口，默认 `1455`。流程与存储方式见 [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/) 和 [app-server 认证接口](https://developers.openai.com/codex/app-server/#authentication)。

浏览器登录等待期间按 Esc 取消，五分钟未完成会超时；取消和失败都会清理临时目录与子进程。登录成功但保存失败时可直接重试保存，无需重新登录；返回后通知服务端丢弃内存中的本次凭证；关闭服务端也会取消登录并清理。保存成功默认「完成」，也可选「立即切换」，继续使用现有的当前登录备份、版本冲突和运行中 Codex 确认流程。只有切换会改写本机当前登录文件。

添加或保存失败时显示错误并停留在当前步骤，可以直接重试或按 Esc 返回；路径输入框会保留上次输入的内容。退出时打印一行当前账号。连接或配置读取失败时以非零状态退出；Esc 或 Ctrl+C 取消时正常退出。

状态栏区分未找到登录文件、文件无效或无法读取、有效但未保存等状态。无效文件会提示重新登录或从其他文件添加，禁用「当前 Codex 登录」来源，不推荐保存。当前账号按以下规则识别：本机登录文件 经过同样的字段过滤后，其 SHA-256 摘要与服务端某个已保存凭证的摘要一致时显示为该账号；内容不同但邮箱一致时，结合服务端 `login.json` 的 baseline 和有效刷新时间区分「有更新未保存」「服务端有更新版本」「与服务端版本不一致」，服务端有更新时可请求更新当前登录；否则显示为「未保存」。状态由服务端识别，API 仅返回状态和邮箱；列表返回摘要和刷新时间，TUI 不下载凭证。识别结果用于界面展示和切换前的保存提醒，不校验 `id_token` 签名，也不参与添加时的邮箱判定。

## 独立本机服务端

独立服务端供同一台电脑上的 API 调用方使用：

```sh
codexplus-server --port 47831 --home ./data
```

服务端固定监听 `127.0.0.1`，默认端口为 `47831`。凭证库、同步基线和删除记录由服务端的 `--home` 决定，当前登录文件使用服务端启动时的 `CODEX_HOME`。TUI 始终自带服务端，不连接这个独立进程。

删除账号需要再次确认（默认取消），按列表摘要提交（凭证文件缺失或损坏时提交 null，删除列表会显示说明，仍可确认删除）；服务端已更新时刷新后重新决定。本机 auth.json 不受删除影响。

**查看账户信息**直接展示当前登录账号的脱敏邮箱、套餐、到期时间、五小时及每周剩余额度和重置时间。进度条表示剩余额度，低于或等于 25% 时用黄色、低于或等于 10% 时用红色提示，仍保留数字；日期按本地时区显示。可选择「刷新」重新查询，选择「返回」或按 Esc 回主菜单。未登录或登录无效时不可进入；当前登录未保存、已从凭证库删除或与保存版本不一致时仍可查询，始终使用当前登录文件，不切换账号或修改凭证。

额度来自 `GET https://chatgpt.com/backend-api/wham/usage`，按 `limit_window_seconds` 区分五小时与每周窗口，不按 primary/secondary 的位置猜测。字段对照 [Codex 官方额度模型](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs)。套餐到期时间独立读取 `GET https://chatgpt.com/backend-api/subscriptions?account_id=...` 的 `active_until`，不使用 JWT 有效期、登录时的订阅快照或额度重置时间代替。缺失窗口或到期时间显示「未提供」；订阅查询失败仍展示成功取得的额度。接口仅使用已有 access token，不刷新 token；TUI 只接收账户信息，不接收凭证。

**使用 Codex 重置卡**位于「查看账户信息」之后。先从已保存的账号中选择（包括当前账号），再查询该账号的可用重置卡；每张卡片名称后直接显示过期时间，按过期时间由近到远排列，未提供过期时间的卡片排在最后并标注「过期时间：未提供」。选中卡片时下方还显示说明、获得时间和到期时间；已使用、处理中和已到期的卡片不列出。无可用卡片时可以改选账号。选卡后再次确认，默认取消；Esc 从确认返回卡片列表，从卡片列表返回账号列表，从账号列表回到主菜单。确认后仅使用所选卡片，结果区分成功、此前已成功、当前无需重置和无可用次数，不自动重试或改用另一张卡；网络异常时提示先查看用量和卡片状态。同一客户端会话内，对结果未知的同一账号、同一卡片再次发起请求时沿用原请求 ID。此功能不切换账号、不改写当前登录文件。

重置卡查询和使用由服务端读取所选账号保存的凭证完成，TUI 仅接收卡片信息及使用结果。接口与字段对照 [Codex 官方 backend-client 源码](https://github.com/openai/codex/blob/ee344ca9458351a6ea102795fa73110ad3ede5dc/codex-rs/backend-client/src/client/rate_limit_resets.rs)：查询 `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`，使用 `POST .../consume`，提交指定的 `credit_id` 和幂等字段 `redeem_request_id`。与账号查询相同，仅发送已有 access token 和可选的 `ChatGPT-Account-Id`，不自行刷新 token；接口变化或凭证过期会显示错误。

`codexplus-server log [--limit 条数] [--home 目录]` 按时间顺序显示最近操作，默认 50 条。记录成功的下载、实际写入的上传、删除、切换和重置，最多保存 1000 条，不含 token 或凭证内容；每条包含时间、事件、操作者「本机」和账号邮箱。上传、删除、切换和重置在完成后记录，记录写入失败不影响结果，只在服务端输出一行警告；下载在返回凭证前记录，记录失败时不返回凭证。重置仅在上游返回本次成功重置时记录，重复请求返回「此前已成功」不重复记录。

`log` 要求数据目录已存在且是目录，否则报错并提示检查 `--home`，不会创建目录；服务端未运行时也可读取日志，不接受 `--port`。启动服务端时会自动创建所需目录。

## 文件位置

| 所属 | 用途 | 路径 |
| --- | --- | --- |
| 共享 | 跨进程瞬时锁 | `<home>/.lock` |
| 服务端 | 凭证索引，沿用原格式 | `<home>/config.json` |
| 服务端 | 已保存账户凭证（明文，依赖文件权限保护） | `<home>/credentials/codex-<邮箱>/auth.json` |
| 服务端 | 操作记录（最多 1000 条） | `<home>/audit.log` |
| 服务端 | 当前登录路径、同步基线和删除记录 | `<home>/login.json` |
| 服务端 | 当前供 Codex 使用的账户凭证 | 服务端 `$CODEX_HOME/auth.json`，未设置时为 `~/.codex/auth.json` |

`<home>` 是服务端的数据目录：正式 TUI 固定使用 `~/.codexplus`，独立服务端可通过 `--home` 指定。文件导入中的相对路径按服务端工作目录解析，`~/` 按服务端用户主目录展开。登录文件由服务端的 `CODEX_HOME` 决定，未设置时使用其操作系统用户的 `~/.codex/auth.json`，不会被 `--home` 改变。进程检测、浏览器登录和 CodexBar 同步均由服务端执行。

### CodexBar 联动

服务端成功切换账号后，若找到 CodexBar 配置及其中的 Codex 提供项，会自动更新该项的 `codexProfileHomePaths`：当前账号由 CodexBar 从本机 Codex 登录读取，不再列入额外目录；其余可读取的已保存账号使用 `<home>/credentials/codex-<邮箱>`。再次切换时，原账号会回到额外目录列表，新账号会从列表中移除。已删除、缺失或损坏的 codexplus 凭证也会在下次切换时从列表清理。仅维护当前 `<home>/credentials` 下的 `codex-*` 目录，其他手动添加的路径、提供项及设置保持不变。

配置路径遵循 [CodexBar 的规则](https://github.com/steipete/CodexBar/blob/v0.84.0/Sources/CodexBarCore/Config/CodexBarConfigStore.swift)：优先使用 `CODEXBAR_CONFIG`，其次是绝对路径的 `$XDG_CONFIG_HOME/codexbar/config.json`（支持 `~/` 展开），否则优先 `~/.config/codexbar/config.json`，不存在时使用旧版 `~/.codexbar/config.json`。配置不存在、为空或没有 Codex 提供项时跳过，不创建配置；自带和独立服务端都使用服务端的环境变量及用户目录定位配置。写入使用原子替换和 `0600` 权限，同步失败会提示，但不会撤销已完成的账号切换。

同目录的多个进程通过瞬时 `<home>/.lock` 串行读写；锁等待最多 10 秒，超过 30 秒的残留会回收，回收过程由瞬时的 `<home>/.lock.reclaim` 互斥，避免两个进程同时回收后都拿到锁；这个标记不会自动回收，进程恰好在回收中途崩溃时会留下它，此后残留锁不再被回收，命令会报错并提示在确认没有其他 codexplus 运行后手动删除；进程在写入锁内容前崩溃留下的空锁按文件修改时间判断。账号网络查询在锁外，健康接口不受慢查询阻塞。Windows 原子重命名遇到外部读取占用时重试约 2 秒。

服务端凭证索引不保存 token，格式不变：

```json
{
  "version": 1,
  "credentials": [
    { "type": "codex", "email": "person@example.com" }
  ]
}
```

文件通过同目录临时文件和重命名写入。Unix 上新建的敏感文件权限为 `0600`，新建目录为 `0700`。账户凭证文件依赖操作系统文件权限保护，不加密。API 响应禁用缓存，不开放浏览器跨站访问，JSON 请求上限为 128 KiB。

## 凭证内容与 Codex 配置

目前仅支持 `codex` 类型和通过 ChatGPT 登录生成、包含 `tokens.access_token` 的 `auth.json`，不支持只有 API key 的文件。只保留顶层的 `auth_mode`、`OPENAI_API_KEY`、`tokens`、`last_refresh`，以及 `tokens` 内的 `id_token`、`access_token`、`refresh_token`、`account_id`。其他字段全部丢弃；保留字段的原值不变，缺失字段不补齐，已有 `null` 原样保留。

添加时由服务端请求 `https://chatgpt.com/backend-api/me`，发送已有 access token，存在 `tokens.account_id` 时同时发送 `ChatGPT-Account-Id`。邮箱使用响应的顶层 `email` 字段。请求超时为 15 秒，不跟随重定向，错误信息不打印 token 或接口响应内容。该账号资料接口没有公开的稳定契约，可能因接口变更、token 权限或访问限制而失败。失败不会退回到本地解码 token 或凭空生成邮箱。

读取、校验或账号查询失败时不更新已有配置和凭证。服务端索引提交失败时恢复本次替换的凭证。服务端读取所选凭证失败时，不覆盖当前登录。

浏览器登录由服务端调用官方 Codex CLI 完成；codexplus 不自行刷新 token，过期后可以再次浏览器登录，或在 Codex 中重新登录后保存。凭证库保存添加时的快照，Codex 后续刷新当前登录的 token 不会自动同步到凭证库。

服务端读取、保存当前登录和切换写入均使用服务端的 `$CODEX_HOME/auth.json`；`CODEX_HOME` 未设置或为空时使用其 `~/.codex/auth.json`。目录支持相对路径和 `~/`，界面显示实际登录文件路径，独立服务端的 `--home` 仅控制 codexplus 数据目录。Codex 需要使用文件凭证存储；如果当前配置使用系统钥匙串，需要自行设置实际 Codex 目录内的 `config.toml`：

```toml
cli_auth_credentials_store = "file"
```

Codex 的存储方式说明见 [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/)。本工具不会修改 Codex 的其他配置。

服务端采用 JSON-RPC 2.0 over HTTP，应用协议版本为 5；连接前检查服务名称和版本，不兼容时不进行凭证操作。TUI 仅提交路径、账号、本次登录标识及确认参数，服务端响应元数据和操作结果。保存响应为 `{ credential, changed }`，相同内容不记上传操作记录，保存当前登录时仍记录服务端同步基线。冲突通过 `error.data.status: 409` 返回，确认后以最新摘要重试；重新保存已删除的账号须确认并提交 `restore: true`。切换、保存当前登录和更新当前登录后记录基线，从其他文件或浏览器添加不记录。

所有方法通过 `POST /rpc` 调用，`Content-Type` 为 `application/json`，`params` 使用命名参数对象（无需参数时可省略），旧 `/v1/*` 路由已移除。服务端提供以下本机方法，不提供配对或远程授权，并拒绝浏览器跨站请求和非本机 Host；客户端不跟随 HTTP 重定向。独立本机服务端直接接受本机客户端请求，自带服务端除 `health` 外使用内存会话令牌（`Authorization: Bearer <token>`），批量请求中包含其他方法时同样需要鉴权：

| JSON-RPC 方法 | 内容 |
| --- | --- |
| `health` | 服务名称、应用协议版本 5 |
| `login.info` | 服务端数据目录、用户主目录和当前登录文件路径 |
| `login.current` | 当前登录账号及同步状态，不含凭证 |
| `login.processes` | 服务端检测到的 Codex 进程 |
| `login.restartServer` | 重启当前登录目录的 Codex 托管后台服务 |
| `login.refreshTimes` | 按 type、email 查询当前登录和凭证库刷新时间 |
| `login.save` | 保存服务端当前登录，可带 base、restore |
| `login.switch` | 按 type、email 在服务端切换当前登录 |
| `credentials.validate` | 服务端校验 path 指向的文件 |
| `credentials.import` | 服务端读取 path 并保存，可带 base、restore |
| `login.browser.start` | 启动服务端浏览器登录，返回本次登录标识 |
| `login.browser.status` | 按 id 查询链接、进度或错误，不含凭证 |
| `login.browser.save` | 按 id 保存服务端持有的凭证，可带 base、restore |
| `login.browser.cancel` | 按 id 取消并清理本次登录 |
| `credentials.list` | 账号、摘要、lastRefresh |
| `login.accountInfo` | 当前登录账号的套餐、到期时间、五小时及每周剩余额度，不含凭证 |
| `credentials.upload` | 上传 `{ auth, base }` |
| `credentials.download` | 按 type、email 下载 |
| `credentials.delete` | 按 type、email、base（摘要或 null，必填）条件删除 |
| `resetCards.list` | 按 type、email 查询所选账号可用的重置卡，不含凭证 |
| `resetCards.use` | 按 type、email、cardId、requestId 使用指定卡片，返回 outcome |
| `antigravity.status` | 当前 agy 文件路径、状态和已保存账号的元数据 |
| `antigravity.inspect` | 校验 `path` 指定的 agy 文件并返回账号和摘要 |
| `antigravity.save` | 按 `sourceDigest` 和 `base` 条件保存，省略 `path` 时保存当前 agy 文件 |
| `antigravity.switch` | 按 `account`（email、digest）和 `currentDigest` 条件替换当前 agy 文件 |

调用示例：

```sh
curl http://127.0.0.1:47831/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"health"}'
```

成功响应为 `{"jsonrpc":"2.0","id":1,"result":{"service":"codexplus","version":5}}`。单次调用原样回显 `id`；省略 `id` 表示通知，执行后不返回 JSON-RPC 响应，HTTP 状态为 204。批量请求使用数组，服务端按数组顺序执行，仅返回需要响应的条目；全部为通知时返回 204，批量请求不保证事务性。

JSON-RPC 响应使用 HTTP 200，错误位于 `error`：`-32700` 表示 JSON 解析失败，`-32600` 表示请求格式无效，`-32601` 表示方法不存在，`-32602` 表示参数无效，`-32603` 表示未预期的内部错误。其他业务错误使用 `-32000`，业务状态和冲突详情放在 `error.data`（例如 `status`、`code`、`digest`）。本机地址、跨站、鉴权、请求大小和媒体类型等 HTTP 层拒绝仍使用对应的 HTTP 4xx 状态。JSON-RPC 的 `id` 仅关联请求和响应，使用重置卡时仍须提供独立的业务 `requestId`。

上传与下载原始凭证的方法保留供直接 API 调用，TUI 不使用这两个接口。交互流程在 packages/tui/src/flows.ts，覆盖确认的提示在 packages/tui/src/prompts.ts。

## 仓库结构

| 包 | 内容 | 依赖 |
| --- | --- | --- |
| `packages/shared`（`@weiguangchao/codexplus-shared`） | 凭证解析与摘要、原子写入、目录锁、JSON-RPC 协议、`--home` 和命令参数解析 | 无 |
| `packages/app-server`（`@weiguangchao/codexplus-server`） | 凭证库、当前登录文件、同步状态、浏览器登录、进程检测、CodexBar、操作记录和本机 JSON-RPC 服务，命令 `codexplus-server` | shared |
| `packages/tui`（`@weiguangchao/codexplus`） | 视图、菜单、输入、确认与 API 调用，命令 `codexplus` | shared、app-server（本机模式内嵌服务端） |

根包为私有工作区入口，三个工作区包公开发布到 npm，版本保持一致。各包测试放在自己的 `test/` 目录；需要同时启动客户端和服务端的测试放在 tui。开发、类型检查和测试通过 `source` 导出条件直接使用其他包的源码，无需先构建；构建用 `tsc -b` 按依赖顺序输出各包的 `dist/`。

## 标签发版

推送 `v0.1.x` 标签触发 `.github/workflows/release.yml`，其中 `x` 是不带前导零的非负整数，例如：

```sh
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

标签应指向已包含发布工作流的提交，并使用尚未使用的版本。版本直接取自标签，工作流临时更新根包、三个工作区包、内部依赖及 lockfile，不提交这些版本变更。下次发布只需推送新的标签，例如 `v0.1.2`。其他版本系列和预发布标签不会发布；匹配 `v0.1.*` 但格式非法的标签会在版本校验时失败。

工作流复用 Linux、macOS、Windows 上 Node.js 22、24 的完整检查和安装验证，全部通过后按 shared → app-server → tui 的顺序公开发布到 npm 的 `latest` 标签。安装验证将三个 tarball 安装到临时全局目录，在仓库外启动两个 CLI，并验证 TUI 的两个帮助选项、旧命令拒绝及非交互启动行为，不创建账号数据。

首次发布前，使用 npm 用户 `weiguangchao` 的个人 scope，无需创建组织。在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置 `NPM_TOKEN`，Token 的包和 scope 权限需允许向 `@weiguangchao` 创建和发布这三个包，并启用 Bypass 2FA；未配置可信发布时，每次发布都需要有效的 token。不要把 token 写入仓库。

首次发布完成后，可分别在三个 npm 包的 Settings → Trusted publishing 中配置 GitHub Actions：用户 `weiguangchao`、仓库 `codexplus`、工作流文件 `release.yml`，允许直接执行 `npm publish`，不填 environment。工作流已启用 `id-token: write` 并使用 npm 11，配置成功后可以删除 `NPM_TOKEN`，后续使用 OIDC 发布。认证要求见 [npm 可信发布文档](https://docs.npmjs.com/trusted-publishers/) 和 [scoped 包发布文档](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)。

npm 已发布版本不可覆盖。若发布中途失败且部分包已经发布，请修复问题并使用新的补丁标签重新发布三个包。

## 开发与验证

```sh
npm ci
npm run check
npm run test:package
```

`check` 运行 ESLint、TypeScript 类型检查、测试和构建。 领域类型由 Zod schema 推导，文件和 RPC 数据在入口解析；邮箱、凭证摘要和不同用途的 ID 使用独立品牌类型。ESLint 拒绝不安全的 `any` 传播、不安全类型断言、非空断言、遗漏联合分支和 `console` 输出，CLI 输出通过标准输出函数，诊断使用结构化记录。ESLint 限制每个 JavaScript / TypeScript 文件最多 500 行（包含空行），并强制禁止行注释、块注释和 JSDoc；可执行文件的 shebang 不属于代码注释。

可运行 `npm run release:prepare -- v0.1.1` 在本机验证版本同步；此命令会修改根包、工作区包及 lockfile，正式发布由工作流在临时检出目录内完成。

测试使用独立临时主目录、真实本机 HTTP 服务和模拟账号查询接口，覆盖字段过滤、原有凭证兼容、存储回滚、自带本地服务端、TUI 入口限制、版本检查、旧客户端配置迁移、拒绝远程入口、日志离线读取、并发上传、服务端重启、请求限制、条件删除、操作记录与裁剪、服务端登录文件写入、TUI 请求和响应不含凭证、浏览器登录取消与重试和 Unix 文件权限，不读取本机真实凭证。CI 在 Linux、macOS 和 Windows 上使用 Node.js 22、24 执行检查。
