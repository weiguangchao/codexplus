# codexplus

用交互式终端菜单保存和切换已经登录的 Codex / ChatGPT 凭证。

## 安装

需要 Node.js 22.22.2+（22.x）、24.15.0+（24.x）或 26+。

```sh
npm ci
npm run build
npm install --global .
codexplus
```

安装后直接运行 `codexplus`，默认使用 `~/.codexplus` 作为 HOME 目录。可以通过 `--home <路径>` 或 `--home=<路径>` 指定其他目录，支持绝对路径、相对当前工作目录的路径和 `~/`：

```sh
codexplus --home /path/to/codexplus
codexplus --home ./.codexplus
```

不接受子命令或位置参数。

## 使用

主菜单只有两个选项，使用方向键选择，回车确认，Ctrl+C 取消。

- **添加凭证**：输入已有 `auth.json` 的路径，默认为 `~/.codex/auth.json`。支持绝对路径、相对路径和 `~/`。程序使用 `tokens.access_token` 查询邮箱，并将经过字段过滤的凭证保存为 `codex-<邮箱>.json`，不修改源文件。同一邮箱再次添加会更新已有文件，不会切换当前账号。
- **切换凭证**：从已保存的邮箱列表中选择账号，将对应的已保存文件写入 `~/.codex/auth.json`。写入前检查本机 Codex 进程；检测到时列出进程名和 PID，再次确认，默认取消，只有明确选择继续才切换。切换无需联网；没有已保存凭证时会提示先添加。

一次运行完成一次添加或切换；完成后退出。失败时以非零状态退出，Ctrl+C 取消时正常退出。

## 文件位置

| 用途 | 路径 |
| --- | --- |
| 配置与凭证索引 | `~/.codexplus/config.json` |
| 已保存凭证 | `~/.codexplus/credentials/codex-<邮箱>.json` |
| 切换目标 | `~/.codex/auth.json` |

上表中的配置和已保存凭证路径以默认 HOME 目录为例。指定 `--home <目录>` 后，分别使用 `<目录>/config.json` 和 `<目录>/credentials/codex-<邮箱>.json`。切换目标和添加凭证时 `~/` 的含义仍以系统用户主目录为准。

首次成功添加时创建配置，格式如下。配置不保存 token。

```json
{
  "version": 1,
  "credentials": [
    { "type": "codex", "email": "person@example.com" }
  ]
}
```

目前仅支持 `codex` 类型和通过 ChatGPT 登录生成、包含 `tokens.access_token` 的 `auth.json`，不支持只有 API key 的文件。添加时只保留顶层的 `auth_mode`、`OPENAI_API_KEY`、`tokens`、`last_refresh`，以及 `tokens` 内的 `id_token`、`access_token`、`refresh_token`、`account_id`。其他字段全部丢弃；保留字段的原值不变，缺失字段不补齐，已有 `null` 原样保留。过滤后的凭证重新序列化为 JSON 保存。

文件通过同目录临时文件和重命名写入。Unix 上新建的配置和凭证权限为 `0600`，新建目录为 `0700`。读取文件、校验或账号查询失败时不更新已有配置和凭证。配置提交失败时恢复本次替换的凭证。

## 账号查询与 Codex 配置

添加时请求 `https://chatgpt.com/backend-api/me`，发送已有 access token，存在 `tokens.account_id` 时同时发送 `ChatGPT-Account-Id`。邮箱使用响应的顶层 `email` 字段。请求超时为 15 秒，不跟随重定向，错误信息不打印 token 或接口响应内容。

该账号资料接口没有公开的稳定契约，可能因接口变更、token 权限或访问限制而失败。失败时会提示错误，不会退回到本地解码 token 或凭空生成邮箱。程序不登录、不刷新 token；过期后需要在 Codex 中重新登录，再重新添加。

切换目标固定为 `~/.codex/auth.json`，不跟随 `CODEX_HOME`。Codex 需要使用文件凭证存储，并使用默认配置目录；如果当前配置使用系统钥匙串，需要自行设置 `~/.codex/config.toml`：

```toml
cli_auth_credentials_store = "file"
```

Codex 的存储方式说明见 [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/)。本工具不会修改 Codex 的其他配置。切换前应结束正在运行的 Codex 会话，再启动新会话使用所选账号。保存的文件是添加时的快照，Codex 后续对当前登录的 token 刷新不会自动同步到已保存文件。

进程检测在 macOS / Linux 使用 `ps`，在 Windows 使用 `tasklist.exe`，按可执行文件名 `codex` / `codex.exe` 匹配，包括 `codex app-server`。不会按参数中的关键词匹配 `codexplus` 或其他程序，也不会显示进程参数。进程存在无法说明任务是否正忙，也无法确定其使用的凭证目录。检测只覆盖本机可见且名称匹配的进程，不覆盖远程或改名的进程，也不能阻止检查后新启动的进程。检测失败时不切换；检测到进程后选择取消或按 Ctrl+C 均不修改当前凭证。本工具不会终止任何 Codex 进程。

## 开发与验证

```sh
npm ci
npm run dev
npm run check
npm pack --dry-run
```

本地开发和手动测试使用 `npm run dev`，该命令显式传入 `--home .codexplus`，将配置和已保存凭证放在项目根目录的 `.codexplus/` 中；该目录已加入 Git 忽略规则。

`check` 运行 ESLint、TypeScript 类型检查、测试和构建。ESLint 强制禁止 JavaScript / TypeScript 中的行注释、块注释和 JSDoc；可执行文件的 shebang 不属于代码注释。

测试使用临时目录和模拟账号接口，覆盖字段过滤、缺失字段和 `null` 保留、同邮箱更新、离线切换、失败时保护现有文件、配置写入回滚、文件权限和禁止注释规则，不读取本机真实凭证。CI 在 Linux、macOS 和 Windows 上使用 Node.js 22、24 执行相同检查。实际账号接口仍需要用户自己的有效凭证进行联网验证。
