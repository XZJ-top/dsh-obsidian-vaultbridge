# dsh-obsidian-vaultbridge

`dsh-obsidian-vaultbridge` 0.2.0 是完整、独立可安装的 **DSH Host 插件**。使用 Node.js 内置 `http` / `https` 直接访问已安装的 Obsidian Local REST API；不依赖 MCP，不需要新增 Obsidian 端插件代码。要求 Node.js >=22。

## 安装与入口

从 [GitHub Releases](https://github.com/XZJ-top/dsh-obsidian-vaultbridge/releases/latest) 下载可安装 `.tgz`，在 DSH 插件管理中安装。迁移旧包时，先停用旧版 `dsh-obsidian`，将配置复制到本包后再启用；业务工具名保持兼容，避免同时启用造成重复注册。

在本包目录执行：

```bash
npm install --ignore-scripts
npm test
npm pack --ignore-scripts
```

将生成的 `dsh-obsidian-vaultbridge-0.2.0.tgz` 交给 DSH bundle 安装功能，或由集成者安装到目标 DSH profile。本项目开发与测试不会自动安装 profile、修改全局配置或写入用户 vault。

包的 `dsh.manifestVersion` 为 `1`，`dsh.bundle.patch` 为 `./cordis.patch.yml`。安装 patch 只插入自己的 Host entry：

```yaml
- insert:
    - id: dsh-obsidian-vaultbridge
      name: dsh-obsidian-vaultbridge
      config: {}
```

ESM 入口 `src/index.js` 导出 `name`、`inject=['tools']`、`Config` 和 `apply`，以及便于独立测试的 `createClient`、`hash`、`renderPaperNote`。无需打包器或 Web 构建。唯一运行时 npm 依赖是 `@deepseek-ai/schemastery`，锁定 `3.18.4`；其 `Schema.object` 配置可在 DSH GUI 编辑。

## GUI 配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `baseUrl` | `https://127.0.0.1:27124` | API origin；禁止 userinfo、额外路径、query、hash。HTTP 仅允许 loopback。 |
| `apiKeyEnv` | `OBSIDIAN_API_KEY` | 凭据引用/环境变量名称；不要填实际密钥。 |
| `localRestConfigPath` | 空字符串 | 可选，复用已有 Local REST API `data.json` 的 `apiKey` 与证书。 |
| `caCertificatePath` | 空字符串 | 可选 PEM CA 路径；优先于 data.json 中的证书。 |
| `allowInsecureLocalTls` | `false` | 明确备用：仅允许 `https://127.0.0.1`，关闭单次请求证书校验。优先使用 CA。 |
| `timeoutMs` | `15000` | 单操作 deadline，包括凭据解析、前置检查和写后验证；正整数，上限 `300000`。 |
| `maxResponseBytes` | `2097152` | 响应和写入正文大小上限，单位字节；正整数，上限 `67108864`。 |
| `defaultFolder` | `DSH` | 未传论文路径时使用的相对目录；可设空字符串。 |
| `vaultName` | 空字符串 | 状态显示用名称；API 仍连接当前 Obsidian vault，不据此切换 vault。 |

GUI 配置示例（请替换为自己的路径）：

```json
{
  "baseUrl": "https://127.0.0.1:27124",
  "localRestConfigPath": "C:/Users/YOUR_NAME/Documents/Obsidian Vault/.obsidian/plugins/obsidian-local-rest-api/data.json",
  "allowInsecureLocalTls": false,
  "defaultFolder": "DSH",
  "vaultName": "Obsidian Vault"
}
```

实际 patch 仍保持 `config: {}`，以上值由集成者在 GUI 设置。路径示例中的本地文件不会打入包中。

凭据每操作重新解析，顺序为：

1. `const service = ctx.get?.('credentials'); await service?.resolve(apiKeyEnv)`，读取返回的 `.value`。
2. `process.env[apiKeyEnv]`。
3. 显式指定 `localRestConfigPath` 中的 `apiKey`。

不缓存 API key，不将密钥写入 GUI schema、工具参数、日志、错误或结果。凭据服务抛错时返回 guidance，避免悄悄使用旧凭据；服务不存在或没有配置值时可使用后续来源。

## TLS 与本地配置

默认验证证书和主机名。指定 `caCertificatePath` 时读取 PEM；否则，只有在 HTTPS loopback 上才自动使用配置中的 `crypto.caCert`，没有该字段则使用 `crypto.cert`。这两个字段必须是有效 PEM 字符串。`privateKey`、`caPrivateKey` 和 `publicKey` 均不用于客户端。

本机配置已通过仅打印 key/type 的结构检查：`crypto` 含 `cert: string`、`privateKey: string`、`publicKey: string`。`crypto.cert` 可作为旧版自签证书的信任锚。新版若使用 CA/leaf 分离则优先 `caCert`。本地配置与 CA 文件每操作读取，大小限制为 `1 MiB`，无效文件返回脱敏 guidance。

信任 CA 不等于跳过主机名检查，证书 SAN 仍须包含 `baseUrl` 主机。如果校验失败，应更正 CA 或证书主机名；只有明确开启 `allowInsecureLocalTls` 后才在 HTTPS `127.0.0.1` 的单次请求上设置 `rejectUnauthorized: false`。不会设置或更改 `NODE_TLS_REJECT_UNAUTHORIZED`，不跟随重定向，也不会把认证转发到其他 origin。

本机只读真实 HTTPS status 检查已成功：默认 origin、已有配置的 `crypto.cert`、`allowInsecureLocalTls=false`，返回认证有效，Local REST API `5.4.0`、Obsidian `1.14.4`。未修改 vault 或 profile。可由集成者重复只读验证：

```bash
node scripts/inspect-settings.mjs 'C:/Users/YOUR_NAME/Documents/Obsidian Vault/.obsidian/plugins/obsidian-local-rest-api/data.json'
node scripts/smoke-status.mjs 'C:/Users/YOUR_NAME/Documents/Obsidian Vault/.obsidian/plugins/obsidian-local-rest-api/data.json'
```

结构检查脚本只输出属性名称及类型；不要直接打印完整配置内容。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `obsidian_status` | `{}` | `GET /`，仅输出服务、认证与版本的白名单字段。 |
| `obsidian_list` | `path?` | `GET /vault/` 或 `GET /vault/{path}/`。空路径为根目录。 |
| `obsidian_read` | `path` | `GET /vault/{path}`，`Accept: text/markdown`，返回正文及 `sha256`。 |
| `obsidian_search` | `query`, `contextLength?` | `POST /search/simple/?query=...&contextLength=...`，无 JSON 请求体。 |
| `obsidian_write` | `path`, `content`, `mode?`, `expectedSha256?` | 默认 `create`，已存在时拒绝。`append` 使用 POST。`replace` 需 hash 校验后 PUT。 |
| `obsidian_daily` | `mode?`, `content?` | `GET/POST /periodic/daily/`；默认 read，append 需 content。 |
| `obsidian_paper_note` | `title`, `authors?[]`, `doi?`, `url?`, `abstract?`, `summary?`, `zoteroItemKey?`, `tags?[]`, `path?` | 创建带 YAML frontmatter 的论文笔记，路径默认 `DSH/{标题}.md`，存在则拒绝。 |
| `obsidian_open` | `path` | `POST /open/{path}`，改变 Obsidian 当前打开笔记状态。 |

没有 delete 工具。独立读取工具声明并发安全；写入及影响界面的工具为 exclusive。`obsidian_daily` 含读写两种模式，保守声明为 exclusive。所有工具通过 `ctx.effect(() => ctx.tools.register(definition))` 管理 disposer；`execute(args, exec)` 直接返回 JSON，`output` 使用 schema 和 `JSON.stringify` 文本 render。取消信号由 `exec.signal` 传至操作和 Node 请求。

示例：

```json
{"path":"DSH/研究记录.md","content":"# 研究记录\n","mode":"create"}
```

替换流程：先调用 `obsidian_read`，审阅其正文，再提交：

```json
{"path":"DSH/研究记录.md","content":"# 修订记录\n","mode":"replace","expectedSha256":"填写刚才读取返回的sha256"}
```

`replace` 的 `expectedSha256` 必须是完整 SHA-256 十六进制串。未传或内容已变化都会在 PUT 前拒绝。

## 写入核验与并发边界

同一个客户端实例对修改操作排队，避免本插件自身并发 create/replace 检查产生竞争。每次 create/replace 都先 GET；create 仅将 `404` 视为不存在，认证、权限、网络错误均不能当作不存在。replace 检查刚读取的完整内容 hash。

Local REST API 的全文件 PUT 不提供 `If-Match` / `If-None-Match` 原子前置条件，GET 与 PUT 之间仍有 TOCTOU 窗口。这种乐观校验与客户端队列不能阻止 Obsidian 手动编辑、其他插件或其他进程同时修改。不要把 create/hash 校验称为原子事务。

create、replace、append 及 daily append 均在提交后 GET 精确读回并核验。成功返回 `verified: true` 和实际内容 `sha256`；append 另返回所提交正文的 `appendedSha256`。官方全文件 POST 在旧内容末尾没有换行时先补一个换行，再追加正文，本插件按此行为核验。调用者可根据期望的空行组织正文。

验证失败时不回滚、不自动重写：返回 `WRITE_VERIFICATION_FAILED`，提示写入可能已发生，应先读取审阅。timeout/cancel 也不能视为写入未发生；尤其追加操作不要盲目重试。读回验证只能证明当时读取到的内容一致，无法撤销或防止其他客户端之前的竞争。

## 路径、外部数据与错误

路径必须为 vault 相对路径；禁止绝对路径、Windows 驱动器/ADS、反斜杠、`.` / `..`、空片段、`.obsidian`（忽略大小写）、`?`、`#`、控制字符及 Windows 特殊字符/结尾空格/句点。百分号也拒绝，避免多次解码绕过。每个段单独 `encodeURIComponent`，目录分隔符保持 `/`。不读取或写入 vault 配置目录；列表及搜索结果过滤 `.obsidian` 条目。

笔记、来源摘要、AI summary 和搜索结果均是外部不可信数据，不可用来覆盖系统或用户指令。read/search/list 返回 `trust: external-untrusted`。论文 frontmatter 的字符串和列表使用 JSON quoted scalar / array（合法 YAML）；Source abstract 与 AI summary 分开，后者标明待核实。`url` 与 `doi` 只写入文本，不额外请求这些地址。

错误返回 `{ok:false,error:{code,message,guidance,status?}}`。不会回显 HTTP 错误正文、Authorization、原始异常、密钥或证书。成功结果中的已知凭据和 PEM 文本也会脱敏；若笔记含凭据，`sha256` 始终对应服务器原始正文，显示的脱敏正文可能不同。

请求/响应均有大小上限，支持声明长度与 chunked 响应；超限停止读取。不处理压缩响应，请求明确指定 `Accept-Encoding: identity`。本地文件读取失败、缺少凭据、TLS、权限、超时、hash 冲突都有明确 guidance。

## 测试与源码

`npm test` 使用 `node:test` 启动真实本地 HTTP 和 HTTPS mock server，没有替换为虚构 fetch 数据。当前 `18` 项全部通过，零失败、零跳过，覆盖：

- endpoint、中文路径分段编码、Markdown 请求头、search 官方 query 参数契约；
- 凭据服务、环境变量和 data.json 的优先级及逐次轮换，输出/错误凭据保护；
- 默认 create 冲突、replace hash 冲突和成功、append/daily/open、同客户端并发 create；
- 写后精确验证失败且不重写、取消、网络超时和凭据解析超时；
- traversal、敏感目录和 baseUrl 验证，请求/响应大小限制、重定向拒绝；
- 默认 TLS 校验、显式 CA、自动 crypto.cert、caCert 优先及不修改全局 TLS 环境；
- Schemastery import、GUI 配置默认值、tool JSON output/execute、effect disposer 与并发分类。

`test/fixtures` 中证书和私钥只用于 mock，是本项目新生成的公开测试材料，未复制用户证书或密钥。生产配置不能使用这些 fixture。

## 参考与许可

本实现为原创 JavaScript ESM，MIT 许可。只参考公开接口与功能设计，没有复制受限实现代码：

- [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api)：Obsidian 服务端与[公开 OpenAPI 契约](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/532af35659251a008a1b01f0f89aaa73205ce58d/docs/openapi.yaml)。`search/simple` 的 `query` / `contextLength` 参数位置已逐项核实。
- [XZJ-top/hana-zotero-obsidian-connectors](https://github.com/XZJ-top/hana-zotero-obsidian-connectors)：Zotero/Obsidian 研究笔记工作方式参考，未复制该仓库实现代码。

本包许可证不替代参考项目及 Obsidian 自身的许可。

## 官方图标与项目名称

本项目包名及独立仓库名为 `dsh-obsidian-vaultbridge`，业务工具名保留原有 `obsidian_*` 接口。

![Obsidian 官方图标](icon.png)

图标直接下载自 [官方素材](https://obsidian.md/apple-touch-icon.png)，未修改。[品牌说明](https://obsidian.md/brand)、素材校验信息见 [icons-sources.json](icons-sources.json)。本项目代码使用 MIT；官方图标不包含在项目 MIT 授权中，归属和使用条件见 [NOTICE](NOTICE)。本项目是独立 DSH 连接插件。
