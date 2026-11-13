<p align="center">
  <img src="assets/logo.png" alt="codexplus logo" width="160" />
</p>

# codexplus

通过 C/S 架构集中保存 Codex / ChatGPT 凭证，在用户自己的电脑上用 TUI 添加和切换账号。仓库是 npm workspaces 组成的 monorepo，提供两个命令：

- **服务端**（`codexplus-server`，包 `packages/app-server`）保存账户凭证，查询账号邮箱，通过仅监听 `127.0.0.1` 的 HTTP 接口提供凭证管理。
- **客户端**（`codexplus`，包 `packages/tui`）是本机 TUI。添加时上传本机文件，切换时下载所选凭证并写入本机登录文件（默认 `~/.codex/auth.json`，设置 `CODEX_HOME` 时使用该目录）。Codex、文件操作和任务执行都在客户端电脑上；服务端不运行 Codex 任务。

## 安装

需要 Node.js 22.22.2+（22.x）、24.15.0+（24.x）或 26+。

```sh
npm ci
npm run build
npm install --global ./packages/tui         # 客户端：codexplus
npm install --global ./packages/app-server  # 服务端：codexplus-server
```

直接使用时安装客户端即可，其中包含本机服务端；独立运行服务端时可单独安装 app-server，不需要 TUI 依赖。全局安装会链接到仓库目录，因此需要保留仓库并在更新后重新运行 `npm run build`。

开发时使用 `npm run dev`（客户端）和 `npm run dev:server`（服务端），两者直接运行源码，都显式传入 `--home .codexplus`，将数据放在项目根目录已忽略的 `.codexplus/` 中。

## 命令

```sh
codexplus [--port 本机端口] [--home 目录]
codexplus status|list [--port 本机端口] [--home 目录]
codexplus switch [邮箱] [--port 本机端口] [--home 目录]
codexplus-server [--port 47831] [--home 目录]
codexplus-server log [--limit 条数] [--home 目录]
```

旧的 `codexplus serve ...` 已改为 `codexplus-server ...`，运行旧命令会报错并提示新命令。独立服务端监听端口默认 `47831`，可用 `--port` 指定。`--home <目录>` 或 `--home=<目录>` 指定数据目录，默认 `~/.codexplus`，支持绝对路径、相对路径和 `~/`。

不带子命令时打开原有交互式菜单，以下命令执行完成后退出：

| 命令 | 功能 |
| --- | --- |
| `codexplus status` | 显示运行模式、数据目录或服务地址、本机登录文件、当前账号及同步状态、已保存账号数量。 |
| `codexplus list` | 按邮箱排序列出当前凭证库中的账号，标记当前账号及缺失或损坏的凭证。 |
| `codexplus switch [邮箱]` | 精确匹配邮箱切换账号；省略邮箱时打开账号选择，切换到与凭证库一致的当前账号时提示无需切换。 |

这三个命令都支持 `--port` 和 `--home`。默认启动自带的本机服务端；指定 `--port` 时只连接 `127.0.0.1` 上已运行的独立服务端。`status` 和 `list` 支持管道和输出重定向，不输出凭证内容；连接失败会报错并以非零状态退出，不会显示为空列表。

指定邮箱只跳过账号选择，切换仍沿用当前登录保存提醒、版本冲突处理和运行中 Codex 确认。指定账号不存在时以非零状态退出；非交互环境中，只有无需选择或确认的指定账号切换可以执行，需要确认时以非零状态退出，本机登录文件保持不变。

```sh
codexplus status
codexplus list --port 47831
codexplus switch person@example.com --home ./data
```

## 本机使用

直接运行 `codexplus` 时，每个客户端进程自带服务端，监听 `127.0.0.1` 的随机端口，通过 HTTP 接口访问数据，退出时关闭。自带服务端沿用仅存在内存的本机会话令牌，不保存客户端授权记录。保留客户端、服务端分离的 C/S 架构，客户端与服务端之间的数据通信在本机完成，不需要配对。

通过 `--port <端口>` 连接已运行的独立本机服务端，失败时不自动启动或改写配置；端口不会被记住，下次不带 `--port` 仍启动自带服务端。客户端不接受服务端 URL，服务端不提供监听地址或 TLS 配置。

旧版 `client.json` 在成功连接后迁移为版本 3，删除所有连接地址、客户端令牌和配对信息，只保留原本标记为 `local` 的同步基线；旧远程连接不会被访问。`server-access.json` 和 `local-codes/` 不再读取或写入，已有文件可以自行删除。原有 `config.json` 和账户凭证继续使用；旧的 `credentials/codex-<邮箱>.json` 在首次读取或保存时自动迁移到 `credentials/codex-<邮箱>/auth.json`，内容和同步摘要不变。新旧文件同时存在时以新路径为准，并移除旧文件。

## 菜单

启动后顶部显示「本地模式」；自带服务端显示数据目录，连接独立本机服务端时显示回环服务地址。登录文件单独展示，指向本机的 Codex 登录文件。下方显示当前 Codex 登录的账号、服务端已保存账号数量和主菜单。方向键移动，回车确认，Esc 返回上一级（在主菜单中退出），Ctrl+C 随时取消。

长路径按终端宽度独立显示或保留首尾省略。路径输入框随光标横向滚动，`‹`、`›` 表示左右还有未显示的内容；完整路径仍用于编辑、校验和上传。支持方向键、Home/End、退格、Delete 和 Ctrl+U 清除光标左侧内容。

- **切换账号**：从服务端已保存的邮箱列表中选择，下载对应凭证并写入客户端当前使用的登录文件。当前账号标记为「● 当前」且不可选。当前登录未保存或本机有更新时，会先询问是否保存再切换；与服务端版本不一致时显示两边的刷新时间，可以选择先用本机登录覆盖服务端、不保存直接切换或返回；只有摘要基线与刷新时间共同表明服务端较新时不提醒保存。写入前检查本机 Codex 进程；检测到时列出进程名和 PID，再次确认，默认取消，只有明确选择继续才切换。切换不再次请求 ChatGPT 账号接口，但需要连接服务端；成功后退出。
- **添加账号**：可以通过浏览器登录、直接上传当前 Codex 登录（首屏显示实际登录文件路径），也可以手动输入其他 `auth.json` 路径，支持绝对路径、相对路径、`~/`，以及拖入终端时带引号或 `\ ` 转义空格的路径。按回车确认时会先检查文件是否存在、是否包含 `tokens.access_token`，有问题直接在输入框下方提示。当前 Codex 登录与服务端保存的凭证一致时，不会重复上传。客户端校验并过滤内容后上传，服务端使用 `tokens.access_token` 查询邮箱并保存为 `credentials/codex-<邮箱>/auth.json`，查询时显示加载动画，不修改源文件。同一邮箱再次添加须匹配基线摘要，冲突时显示两边刷新时间并确认后重试。上传内容与服务端一致时不写盘，提示「已是最新，无需更新」；文件导入完成后回到主菜单。

「浏览器登录」要求客户端已安装官方 Codex CLI，且 `codex` 在 `PATH` 中；本次验证使用 `0.167.2`。客户端通过 `codex app-server` 的 `account/login/start`（`type: "chatgpt"`）复用官方浏览器认证，打开系统浏览器，等待本机回调；自动打开失败时可手动打开终端显示的链接。登录进程使用独立临时 `CODEX_HOME` 和文件凭证存储，完成后读取凭证到内存、退出进程并删除临时目录，再上传到当前连接的凭证库。通过 SSH 使用 TUI 时，需要让浏览器能够访问运行 TUI 的电脑上的回调端口，默认 `1455`。流程与存储方式见 [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/) 和 [app-server 认证接口](https://developers.openai.com/codex/app-server/#authentication)。

浏览器登录等待期间按 Esc 取消，五分钟未完成会超时；取消和失败都会清理临时目录与子进程。登录成功但保存失败时可直接重试保存，无需重新登录；返回后丢弃内存中的本次凭证。保存成功默认「完成」，也可选「立即切换」，继续使用现有的当前登录备份、版本冲突和运行中 Codex 确认流程。只有切换会改写本机当前登录文件。

添加或保存失败时显示错误并停留在当前步骤，可以直接重试或按 Esc 返回；路径输入框会保留上次输入的内容。退出时打印一行当前账号。连接或配置读取失败时以非零状态退出；Esc 或 Ctrl+C 取消时正常退出。

状态栏区分未找到登录文件、文件无效或无法读取、有效但未保存等状态。无效文件会提示重新登录或从其他文件添加，禁用「当前 Codex 登录」来源，不推荐保存。当前账号按以下规则识别：本机登录文件 经过同样的字段过滤后，其 SHA-256 摘要与服务端某个已保存凭证的摘要一致时显示为该账号；内容不同但邮箱一致时，结合 client.json 的 baseline 和有效刷新时间区分「有更新未保存」「服务端有更新版本」「与服务端版本不一致」，服务端有更新时可下载更新本机登录；否则显示为「未保存」。列表返回摘要和刷新时间，识别时不下载凭证。识别结果用于界面展示和切换前的保存提醒，不校验 `id_token` 签名，也不参与添加时的邮箱判定。

## 独立本机服务端

在一个终端中启动服务端，再在同一台电脑的另一个终端连接：

```sh
codexplus-server --port 47831 --home ./data
codexplus --port 47831
codexplus status --port 47831
```

服务端固定监听 `127.0.0.1`，独立服务端默认端口为 `47831`。客户端与服务端的 `--home` 分别指定各自的数据目录；连接独立服务端时，凭证库由服务端的 `--home` 决定。关闭客户端不会关闭独立服务端。

删除账号需要再次确认（默认取消），按列表摘要提交（凭证文件缺失或损坏时提交 null，删除列表会显示说明，仍可确认删除）；服务端已更新时刷新后重新决定。本机 auth.json 不受删除影响。

`codexplus-server log [--limit 条数] [--home 目录]` 按时间顺序显示最近操作，默认 50 条。记录成功的下载、实际写入的上传和删除，最多保存 1000 条，不含 token 或凭证内容；每条包含时间、事件、操作者「本机」和账号邮箱。上传和删除在完成后记录，记录写入失败不影响结果，只在服务端输出一行警告；下载在返回凭证前记录，记录失败时不返回凭证。

`log` 要求数据目录已存在且是目录，否则报错并提示检查 `--home`，不会创建目录；服务端未运行时也可读取日志，不接受 `--port`。启动服务端和客户端时仍会自动创建所需目录。

## 文件位置

| 所属 | 用途 | 路径 |
| --- | --- | --- |
| 共享 | 跨进程瞬时锁 | `<home>/.lock` |
| 服务端 | 凭证索引，沿用原格式 | `<home>/config.json` |
| 服务端 | 已保存账户凭证（明文，依赖文件权限保护） | `<home>/credentials/codex-<邮箱>/auth.json` |
| 服务端 | 操作记录（最多 1000 条） | `<home>/audit.log` |
| 客户端 | 版本 3：本机凭证库的同步基线 | `<home>/client.json` |
| 客户端 | 当前供本机 Codex 使用的账户凭证 | `$CODEX_HOME/auth.json`，未设置时为 `~/.codex/auth.json` |

`<home>` 是各自的 `--home` 目录，默认 `~/.codexplus`。客户端写自己的 `client.json` 和本机登录文件；使用自带服务端切换时还会同步已存在的 CodexBar 配置，见下文。凭证库由服务端写入服务端目录。客户端自带的本地服务端使用客户端的 `--home`，因此两类文件可以位于同一目录。客户端添加文件时 `~/` 的含义、进程检测以操作系统用户为准；登录文件由 `CODEX_HOME` 决定，未设置时使用操作系统用户的 `~/.codex/auth.json`，不会被 `--home` 改变。

### CodexBar 联动（自带服务端）

使用自带服务端成功切换账号后，若找到 CodexBar 配置及其中的 Codex 提供项，会自动更新该项的 `codexProfileHomePaths`：当前账号由 CodexBar 从本机 Codex 登录读取，不再列入额外目录；其余可读取的已保存账号使用 `<home>/credentials/codex-<邮箱>`。再次切换时，原账号会回到额外目录列表，新账号会从列表中移除。已删除、缺失或损坏的 codexplus 凭证也会在下次切换时从列表清理。仅维护当前 `<home>/credentials` 下的 `codex-*` 目录，其他手动添加的路径、提供项及设置保持不变。

配置路径遵循 [CodexBar 的规则](https://github.com/steipete/CodexBar/blob/v0.84.0/Sources/CodexBarCore/Config/CodexBarConfigStore.swift)：优先使用 `CODEXBAR_CONFIG`，其次是绝对路径的 `$XDG_CONFIG_HOME/codexbar/config.json`（支持 `~/` 展开），否则优先 `~/.config/codexbar/config.json`，不存在时使用旧版 `~/.codexbar/config.json`。配置不存在、为空或没有 Codex 提供项时跳过，不创建配置；连接独立本机服务端时不读取或修改 CodexBar 配置。写入使用原子替换和 `0600` 权限，同步失败会提示，但不会撤销已完成的账号切换。

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

读取、校验或账号查询失败时不更新已有配置和凭证。服务端索引提交失败时恢复本次替换的凭证。客户端下载失败或响应无效时，不覆盖当前登录。

浏览器登录由客户端调用官方 Codex CLI 完成；codexplus 不自行刷新 token，过期后可以再次浏览器登录，或在客户端 Codex 中重新登录后添加。服务端保存添加时的快照，客户端 Codex 后续刷新当前登录的 token 不会自动同步回服务端。

客户端读取、上传当前登录和切换写入均使用 `$CODEX_HOME/auth.json`；`CODEX_HOME` 未设置或为空时使用 `~/.codex/auth.json`。目录支持相对路径和 `~/`，界面显示实际登录文件路径，`--home` 仍仅控制 codexplus 数据目录。Codex 需要使用文件凭证存储；如果当前配置使用系统钥匙串，需要自行设置实际 Codex 目录内的 `config.toml`：

```toml
cli_auth_credentials_store = "file"
```

Codex 的存储方式说明见 [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/)。本工具不会修改 Codex 的其他配置。

HTTP 协议版本为 3；连接前检查服务名称和版本，不兼容时不进行凭证操作。上传包含 `{ auth, base }`，响应为 `{ credential, changed }`，`changed` 表示是否实际写入；相同内容不记上传操作记录，上传当前 Codex 登录时仍记录同步基线。冲突返回 409，确认后以最新摘要重试；没有强制覆盖开关。切换、保存当前登录和下载更新后记录基线，从其他文件添加不记录。

服务端仅提供以下本机接口，不提供配对或远程授权，并拒绝浏览器跨站请求和非本机 Host；客户端不跟随 HTTP 重定向。独立本机服务端直接接受本机客户端请求，自带服务端除健康检查外使用内存会话令牌：

| 方法与路径 | 内容 |
| --- | --- |
| GET /v1/health | 服务名称、协议版本 3 |
| GET /v1/credentials | 账号、摘要、lastRefresh |
| POST /v1/credentials | 上传 `{ auth, base }` |
| POST /v1/credentials/download | 按 type、email 下载 |
| POST /v1/credentials/delete | 按 type、email、base（摘要或 null，必填）条件删除 |

交互流程在 packages/tui/src/flows.ts，覆盖确认的提示在 packages/tui/src/prompts.ts。

## 仓库结构

| 包 | 内容 | 依赖 |
| --- | --- | --- |
| `packages/shared`（`@codexplus/shared`） | 凭证解析与摘要、原子写入、目录锁、HTTP 协议、`--home` 和命令参数解析 | 无 |
| `packages/app-server`（`@codexplus/app-server`） | 凭证库、操作记录、仅本机 HTTP 服务端，命令 `codexplus-server` | shared |
| `packages/tui`（`@codexplus/tui`） | 交互式客户端、本机登录文件读写、Codex 进程检测，命令 `codexplus` | shared、app-server（本机模式内嵌服务端） |

各包都是私有包，不发布到 npm，版本保持一致。各包测试放在自己的 `test/` 目录；需要同时启动客户端和服务端的测试放在 tui。开发、类型检查和测试通过 `source` 导出条件直接使用其他包的源码，无需先构建；构建用 `tsc -b` 按依赖顺序输出各包的 `dist/`。

## 开发与验证

```sh
npm ci
npm run check
npm pack --dry-run --workspaces
```

`check` 运行 ESLint、TypeScript 类型检查、测试和构建。ESLint 限制每个 JavaScript / TypeScript 文件最多 500 行（包含空行），并强制禁止行注释、块注释和 JSDoc；可执行文件的 shebang 不属于代码注释。

测试使用独立临时主目录、真实本机 HTTP 服务和模拟账号查询接口，覆盖字段过滤、原有凭证兼容、存储回滚、自带本地服务端、独立本机端口、版本检查、旧客户端配置迁移、拒绝远程入口、日志离线读取、并发上传、服务端重启、请求限制、条件删除、三类操作记录与裁剪、客户端本地写入和 Unix 文件权限，不读取本机真实凭证。CI 在 Linux、macOS 和 Windows 上使用 Node.js 22、24 执行检查。
