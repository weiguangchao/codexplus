# codexplus

通过 C/S 架构集中保存 Codex / ChatGPT 凭证，在用户自己的电脑上用 TUI 添加和切换账号。

- **`codexplus-server`** 保存账户凭证，查询账号邮箱，管理配对和客户端授权，向已授权客户端下发凭证。
- **`codexplus`** 是本机 TUI。添加时上传本机文件，切换时下载所选凭证并写入本机 `~/.codex/auth.json`。Codex、文件操作和任务执行都在客户端电脑上；服务端不运行 Codex 任务。

## 安装

客户端和服务端都需要 Node.js 22.22.2+（22.x）、24.15.0+（24.x）或 26+。

```sh
npm ci
npm run build
npm install --global .
```

同一个包提供 `codexplus` 和 `codexplus-server` 两个可执行程序。开发时分别使用 `npm run dev` 和 `npm run dev:server`，两者都显式传入 `--home .codexplus`，将配置和服务端凭证库放在项目根目录已忽略的 `.codexplus/` 中。

## 同机使用：无需配对

先启动服务端，保持运行：

```sh
codexplus-server
```

再用同一操作系统用户在另一个终端启动客户端：

```sh
codexplus
```

服务端默认监听 `http://127.0.0.1:47831`。客户端自动读取当前用户的本地认证文件，无需生成或输入配对码；没有启动服务端时会提示启动，不会退回到直接读取凭证库。不同用户或无法读取该文件的客户端应使用配对流程。

已有的 `~/.codexplus/config.json` 和 `~/.codexplus/credentials/` 可以直接继续使用，不需要搬迁或重新导入。凭证库保留在运行服务端的机器上。

主菜单提供：

- **添加凭证**：输入本机已有 `auth.json` 的路径，默认为 `~/.codex/auth.json`，支持绝对路径、相对路径和 `~/`。客户端校验并过滤内容后上传，服务端使用 access token 查询邮箱并保存为 `codex-<邮箱>.json`。同邮箱再次添加会更新，不会切换当前账号；源文件保持不变。
- **切换凭证**：从服务端的邮箱列表选择账号，将下载的凭证写入客户端本机 `~/.codex/auth.json`。不再次请求 ChatGPT 账号接口，但需要连接服务端。没有保存的凭证时提示先添加。
- **配对远程服务端**：输入服务端地址、服务端生成的配对码和客户端名称；配对码输入隐藏。配对成功后保存客户端访问令牌，后续启动自动认证。
- **使用本地服务端（免配对）**：从远程切回本机，或指定本机的自定义端口。连接成功才替换客户端配置；仅接受回环地址。

一次运行完成一次操作后退出。使用方向键选择、回车确认、Ctrl+C 取消。失败以非零状态退出，取消时正常退出。客户端支持 `--home`，不接受子命令或位置参数。

切换前会检测客户端本机的 Codex 进程；发现进程后显示 PID 和命令名，并询问是否继续，默认取消。检测失败不会写入凭证。进程存在不代表任务正在忙，确认继续可能影响已有会话的后续请求。服务端不检测或停止客户端的进程。

## 跨机器使用：先配对

同一局域网里的两台电脑也属于跨机器使用。远程地址必须使用 HTTPS；客户端不接受远程明文 HTTP，也不跟随重定向。

服务端可直接提供 TLS：

```sh
codexplus-server --host 0.0.0.0 --port 47831 --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

也可以保持默认的本机 HTTP 监听，通过已有 HTTPS 反向代理对外提供服务。代理需转发请求路径、JSON 内容和 `Authorization` 头，不能向请求添加 `Origin` 头。服务端不会根据 `X-Forwarded-For` 等代理头免除认证。

在服务端电脑上生成配对码：

```sh
codexplus-server pair
```

如果服务端本机管理地址使用自定义端口或 TLS，为管理命令指定本机地址：

```sh
codexplus-server pair --url https://localhost:47831
```

TLS 证书必须受 Node.js 信任并匹配所用主机名，包括本机管理地址。使用私有 CA 时可通过 `NODE_EXTRA_CA_CERTS` 指定 CA 文件；程序不提供跳过证书校验的选项。

配对码有效期为五分钟，只能使用一次。生成新码会使旧码失效。客户端运行 `codexplus`，选择“配对远程服务端”，输入如 `https://codexplus.example.com` 的根地址、配对码和客户端名称。成功后再次运行客户端即可添加和切换凭证；重启客户端或服务端不需要重新配对。

配对后的客户端可以列出、添加和下载该服务端的全部账户凭证，不能管理配对或撤销其他客户端。管理操作只接受持有本机认证文件的回环连接。

在服务端查看和撤销客户端授权：

```sh
codexplus-server clients
codexplus-server revoke <客户端ID>
```

自定义地址同样使用 `--url`。撤销后客户端的后续服务端请求会被拒绝，需要重新配对。撤销访问授权不会删除客户端已经下载的 `~/.codex/auth.json`，也不会使其持有的账户 token 在 ChatGPT 上失效。

## 文件位置

路径均相对于对应机器上的当前用户主目录。

| 所在机器 | 用途 | 路径 |
| --- | --- | --- |
| 服务端 | 凭证索引，沿用原格式 | `~/.codexplus/config.json` |
| 服务端 | 已保存账户凭证 | `~/.codexplus/credentials/codex-<邮箱>.json` |
| 服务端 | 自动生成的本机认证密钥 | `~/.codexplus/server-key` |
| 服务端 | 配对及客户端授权的哈希 | `~/.codexplus/server-access.json` |
| 客户端 | 服务端地址、远程访问令牌和客户端 ID | `~/.codexplus/client.json` |
| 客户端 | 当前供本机 Codex 使用的账户凭证 | `~/.codex/auth.json` |

默认连接本地地址时无需创建 `client.json`。远程客户端只持久保存连接授权和当前选中的账户凭证，不复制整套服务端凭证库。请在同一个凭证目录上只运行一个服务端实例；所有 API 存储操作由该实例串行提交，避免并发上传丢失索引。

两个程序和服务端管理命令都支持 `--home <目录>` 或 `--home=<目录>`，直接使用指定的配置目录，支持绝对路径、相对路径和 `~/`。例如：

```sh
codexplus-server --home /path/to/vault
codexplus-server pair --home /path/to/vault
codexplus --home /path/to/client
```

服务端将索引、凭证库、本机密钥和授权文件放在自己的指定目录中；客户端将 `client.json` 放在自己的指定目录中。同机免配对时，两者使用相同目录以读取本机认证文件。客户端添加文件时 `~/` 的含义、进程检测和 `~/.codex/auth.json` 的写入目标仍以操作系统用户为准，不会被 `--home` 改变。

服务端凭证索引不保存 token，格式不变：

```json
{
  "version": 1,
  "credentials": [
    { "type": "codex", "email": "person@example.com" }
  ]
}
```

文件通过同目录临时文件和重命名写入。Unix 上新建的敏感文件权限为 `0600`，新建目录为 `0700`。客户端访问令牌以明文保存在客户端连接文件中，服务端只保存其 SHA-256 哈希；账户凭证文件和本机认证密钥依赖操作系统文件权限保护。API 响应禁用缓存，不开放浏览器跨站访问，JSON 请求上限为 128 KiB。

## 凭证内容与 Codex 配置

目前仅支持 `codex` 类型和通过 ChatGPT 登录生成、包含 `tokens.access_token` 的 `auth.json`，不支持只有 API key 的文件。只保留顶层的 `auth_mode`、`OPENAI_API_KEY`、`tokens`、`last_refresh`，以及 `tokens` 内的 `id_token`、`access_token`、`refresh_token`、`account_id`。其他字段全部丢弃；保留字段的原值不变，缺失字段不补齐，已有 `null` 原样保留。

添加时由服务端请求 `https://chatgpt.com/backend-api/me`，发送已有 access token，存在 `tokens.account_id` 时同时发送 `ChatGPT-Account-Id`。邮箱使用响应的顶层 `email` 字段。请求超时为 15 秒，不跟随重定向，错误信息不打印 token 或接口响应内容。该账号资料接口没有公开的稳定契约，可能因接口变更、token 权限或访问限制而失败。失败不会退回到本地解码 token 或凭空生成邮箱。

读取、校验或账号查询失败时不更新已有配置和凭证。服务端索引提交失败时恢复本次替换的凭证。客户端下载失败、授权被撤销或响应无效时，不覆盖当前登录。

程序不登录、不刷新 token；过期后需要在客户端 Codex 中重新登录，再重新添加。服务端保存添加时的快照，客户端 Codex 后续刷新当前登录的 token 不会自动同步回服务端。

切换目标固定为客户端的 `~/.codex/auth.json`，不跟随 `CODEX_HOME`。Codex 需要使用文件凭证存储，并使用默认配置目录；如果当前配置使用系统钥匙串，需要自行设置客户端的 `~/.codex/config.toml`：

```toml
cli_auth_credentials_store = "file"
```

Codex 的存储方式说明见 [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/)。本工具不会修改 Codex 的其他配置。

## 开发与验证

```sh
npm ci
npm run check
npm pack --dry-run
```

`check` 运行 ESLint、TypeScript 类型检查、测试和构建。ESLint 限制每个 JavaScript / TypeScript 文件最多 500 行（包含空行），并强制禁止行注释、块注释和 JSDoc；可执行文件的 shebang 不属于代码注释。

测试使用独立临时主目录、真实本机 HTTP 服务和模拟账号查询接口，覆盖字段过滤、原有凭证兼容、存储回滚、本机免配对、远程配对、一次性及过期配对码、并发上传、重启后认证、授权撤销、请求限制、客户端本地写入和 Unix 文件权限，不读取本机真实凭证。CI 在 Linux、macOS 和 Windows 上使用 Node.js 22、24 执行检查。
