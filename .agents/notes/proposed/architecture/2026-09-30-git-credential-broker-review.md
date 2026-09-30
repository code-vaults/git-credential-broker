# git-credential-broker 设计评审

- **状态**：review（对被评审文档的独立复核，未改动原文）
- **日期**：2026-09-30
- **被评审**：[2026-09-30-git-credential-broker.md](2026-09-30-git-credential-broker.md)（状态 proposed）
- **方法**：把文档里的每条断言拿到**当前容器里实测**（命令与输出见文中「证据」块），
  再对照 GitHub 官方 REST / JWT 文档核对 API 细节。凡文档标「待验证」的，这里给结论。
- **⚠️ 占位值**：内网地址、主机名与仓库名已替换为留档用占位值（`192.0.2.0/24`、
  `example.internal`、`owner/repo`）。**实测结论与超时/可达性判断未改**，只改标识。

---

## 0. 总评

**骨架是对的**，三件事站得住：

1. §2.2 第 1 条（同一 uid 下文件权限挡不住 Agent → 必须引入独立进程）推理正确，
   且实测容器内 `CapEff=0`，降权有效；而 `app.pem` 放在**容器外**后，
   连容器 root 也够不到（容器里根本没有 `/volume1`）。这是本设计真正的价值。
2. 排除 D（Actions）与 E（Vault）的理由成立。
3. App 路线 = HTTPS 路线（§2.2 第 2 条）正确。

**但有 2 个 P0 级问题**：一个会让设计目标（按仓库白名单签发）**静默失效**，
一个会把短期 token 与共享密钥**明文送进局域网上的第三方进程**。
另有 8 条 P1/P2 问题，其中一条与文档自己的安全声明**自相矛盾**。

| 级别 | 数量 | 含义 |
|---|---|---|
| **P0 阻塞** | 2 | 不修则方案目标不成立，或引入比现状更差的泄露面 |
| **P1 重要** | 6 | 会踩坑、削弱承诺、或让验收标准过不了 |
| **P2 完善** | 4 | 实现时容易漏，但漏了就有真实后果 |

---

## 1. P0-1：`credential.useHttpPath` 未处理 → 「仓库白名单」形同虚设

文档 §5.2 第 2 步假设 helper 会收到 `protocol=https` / `host=github.com`，
§5.3 让 helper 把「目标仓库」报给 broker 做白名单判断。
**但 git 默认不会把仓库路径交给 credential helper。**

实测（本地 401 服务器 + 记录 stdin 的 helper）：

```
########## A. 默认配置（git 实际交给 helper 的内容）
== call args:[get]
protocol=http
host=127.0.0.1:8123
== end

########## B. 开启 credential.useHttpPath=true 后
== call args:[get]
protocol=http
host=127.0.0.1:8123
path=owner/name.git          ← 关键：path 只有在开了这个开关后才出现
== end
```

后果非常具体：

- helper 拿不到 `path`，就**无法**按仓库判白名单；若照文档实现，
  要么 broker 只能按 host 发 token（等于把 App 装到的**全部仓库**都授权给这一次 push），
  要么 helper 直接失败。**任何一种都不是文档 §5.3 承诺的语义。**
- 更糟的是它**静默**发生：`{"repos": [...]}` 里的 repos 会退化成「调用方自称」，
  而调用方（Agent）本就不可信 —— 白名单变成纯装饰。

**修复（三件一起做）**：

1. 容器内全局开启路径上报：`git config --global credential.useHttpPath true`
   （或 `credential.https://github.com.useHttpPath true`）。
2. helper 把「**没有 `path`**」当作硬错误，**fail closed**（绝不退化成 host 粒度签发）：
   ```js
   const r = parseKv(stdin);
   if (r.protocol !== "https") fail("只服务 https");
   if (!ALLOWED_HOSTS.has(r.host)) fail("host 不在白名单");
   if (!r.path) fail("缺少 path：credential.useHttpPath 未开启，拒绝按 host 粒度签发");
   ```
3. 验收里加一条**负向测试**：故意 `-c credential.useHttpPath=false`，
   断言 push 失败且错误信息指向该开关（证明退化路径被堵死）。

> 附带注意：`path` 形如 `owner/name.git`，需归一化（去 `.git`、去尾斜杠、小写）；
> 匹配必须**精确相等**，禁止 `startsWith`/前缀匹配，
> 否则白名单里的 `owner/name` 会放过 `owner/name-evil`。

---

## 2. P0-2：LAN 明文 HTTP + 共享密钥 → 短期 token 会被送进第三方代理

文档 §5.1/§7 的方案是「broker 仅监听 LAN，带共享密钥校验」，§6.3 的护栏写
「broker 只监听 LAN，绝不映射到公网」，把 LAN 当成了信任边界。**本容器实测否掉了这个前提**：

```
=== proxy env ===
http_proxy=http://192.0.2.20:7890
https_proxy=http://192.0.2.20:7890
all_proxy=http://192.0.2.20:7890
no_proxy=localhost,127.0.0.1,::1,[::1]
NODE_USE_ENV_PROXY=1                     ← Node 24：fetch/undici 也遵循 *_proxy

=== LAN 可达性 ===
192.0.2.10:443 -> timeout              ← 文档里的「宿主 LAN IP」未验证/未监听
192.0.2.10:3000 -> timeout
192.0.2.1:443 -> ERR ECONNREFUSED      ← 路由器可达（RST）
192.0.2.1:80  -> OPEN
172.24.0.1:443   -> OPEN                  ← docker 网关（宿主）可达
```

两个独立的问题叠在一起：

1. **`no_proxy` 不含 broker 地址。** 于是在容器里对 `http://192.0.2.10:PORT`
   发请求会被代理掉：`NODE_USE_ENV_PROXY=1` 让 Node 的 `fetch` 也走代理，
   git/libcurl 与 shell 工具同样遵循 `http_proxy`。结果是
   **`X-Broker-Key` 和响应里的 `ghs_…` token 都会经过 `192.0.2.20:7890` 这个局域网第三方进程**，
   而明文 HTTP 意味着它在代理上是可读的。这个泄露面**比不做 broker 还差**。
2. **共享密钥保护不了这条信道。** 密钥与 token 走同一条明文信道，
   它只能挡住「不知道密钥的局域网主机来调用」，**挡不住链路上的任何一方**；
   重放也没有窗口限制（静态头、无 nonce/时间戳）。

**修复（按优先级）**：

- **首选：不要走网络，走 unix domain socket。**
  宿主与容器 uid 实测一致（`1026:100`，PUID/PGID 模型的直接结果），
  宿主侧 broker 建一个 socket，容器侧直接 `connect()` 即可：
  - 代理环境变量对它**完全无影响**（不走 TCP，无 `http_proxy` 语义）；
  - 不对局域网暴露任何监听端口，不引入 TLS/重放/嗅探问题；
  - 共享密钥可保留为纵深防御，但不再是唯一闸门。
  socket 落点二选一（见 §10 结论）：
  (a) 新增一个专用 bind mount（推荐，位于 `Workspaces` 之外）；
  (b) 复用 `/home/app/.dsh/git-broker/broker.sock`（零 compose 改动，但见 P1-6）。
- **次选：仍走 HTTP**，则必须同时做到：
  1. broker **只绑 docker 网关**（实测 `172.24.0.1` 可达），不绑 `0.0.0.0`/LAN；
  2. `no_proxy`/`NO_PROXY` 精确加入 broker 地址（两套大小写变量都要，
     且不能指望每个客户端都遵守）；
  3. TLS（或 HMAC 签名 + 时间戳 + nonce + 重放窗口），共享密钥改用签名而非静态头。

**对应的验收补充**：把 `http_proxy` 指向一个**死端口**（如 `http://127.0.0.1:1`）后
push 仍必须成功 —— 这一条能机械地证明「凭据链路不经过代理」。

---

## 3. P1 重要

### P1-1 多 owner 场景缺失：owner → installation 解析（§2.1 硬约束 vs §5.3 接口）

§2.1 明确「目标仓库可能不止一个 owner」，而 §5.3 的接口是
`POST /app/installations/{id}/access_tokens`，凭空假设了**一个** id。实际必须：

1. 用 JWT 调 `GET /app/installations`（或 `/users/{u}/installation`、`/orgs/{o}/installation`），
   按 `account.login` 与 owner 匹配（**大小写不敏感**）取 installation id；
2. 结果**缓存**并在 403/404 时失效重取；
3. `POST .../access_tokens` 的 body 用 `repositories`（**仓库名，不是 `owner/name`**；
   官方 schema 里它是 `string[]`，另有纯数字的 `repository_ids`）；
   文档已确认上限 500 个仓库。

即：broker 内部要做 `owner/name → (installation_id, name)` 的映射，接口需按
owner 分组，而不是文档中扁平的 `{"repos": ["owner/name"]}`。

### P1-2 JWT 细节，文档全篇未提（§7 只留了「openssl 待验证」）

官方要求（[Generate a JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)）：

| claim | 要求 |
|---|---|
| `alg` | 必须 `RS256` |
| `iat` | **往前 60 秒**（防时钟漂移） |
| `exp` | **最多 10 分钟**后 |
| `iss` | App 的 **client ID（推荐）或 app ID** |

这三条是「400 Bad Request」的经典来源，必须显式实现并写进测试。
同时注意 §2.2 第 3 条的「待验证」——**已实测：容器内没有 `openssl` CLI**，
所以 bash 实现直接出局，**只能 Node**（`node:crypto` 的 `createSign('RSA-SHA256')` 足够，
零运行时依赖）。另外 JWT 依赖时钟，NAS 需确保 NTP 同步。

### P1-3 token 复用与新版 token 格式

- **不要每次 helper 调用都铸一次 token。** 一次 push 中 helper 可能被调用多次
  （多仓库、重试、不同 URL），broker 应按
  `(installation, repo, permissions)` 缓存，并在**临近过期（约 5 分钟）前**重铸。
- **`ghs_` token 格式已变**：官方说明自 **2026-04-27** 起灰度推出无状态格式
  `ghs_APPID_JWT`。任何按「40 位十六进制」写死的**脱敏正则或长度校验都会失效**。
  日志脱敏请用宽松规则（如 `ghs_[A-Za-z0-9_]+`），不要做长度/字符集假设。

### P1-4 「fail closed 不回落」需要有人真的设 `GIT_TERMINAL_PROMPT=0`

实测（helper 退出码 3）：

```
C. GIT_TERMINAL_PROMPT=0  → fatal: could not read Username ...: terminal prompts disabled   (exit 128)
D. 未设置、stdin 为 /dev/null → fatal: ...: No such device or address                        (exit 128)
```

两种都不会静默降级 ✅，但**报错质量差别很大**，且 D 依赖「没有 TTY」这一巧合。
二进制里无法替父进程设环境变量，所以必须由容器侧配置兜住
（shell profile / `git config`）。§5.4「broker 不可达 → 报错清晰不回落」应写明**由谁设置**。

### P1-5 「分支保护是最后一道闸门」的两个缺口

- **GitHub App 可以是 ruleset 的 bypass actor**（官方原文：
  「you can allow certain users to bypass the rules in the ruleset. This can be
  users with certain roles, specific teams, or GitHub Apps」）。
  §6.3 的护栏清单**没有**这一条 —— 必须核查该 App **不在**任何 ruleset 的 bypass 列表里，
  否则 §3「不允许 Agent 直接推主干」的承诺是空的。
- **可以用 push ruleset 把「爆炸半径」变成可执行的约束**：
  ruleset 支持 Restrict file paths / extensions / size（对 private/internal 仓库）。
  鉴于容器内可读到通配证书私钥（见 P1-6），建议加一条 push ruleset 拦截
  如 `**/*.key`、`**/*.pem`、`config/ssl/**`，把「最坏多一个 PR」真正钉住。

### P1-6 内部矛盾：§3「爆炸半径有界（最坏多一个 PR）」vs §6.2.2

§6.2 诚实地写了「有推送权限的 Agent 能把它读到的任何内容推出去」，
但 §3 的目标却写「爆炸半径有界：即使凭据被滥用，最坏结果是『多一个 PR』」。
**这两句不能同时成立。** 实测容器内可读：

```
-r-xr-xr-x app  /home/app/Workspaces/gitlab-ee/config/ssl/gitlab-ee.key   → -----BEGIN EC PRIVATE KEY-----
-r-xr-xr-x app  /home/app/Workspaces/gitlab-ee/config/ssl/nas.example.internal.key → -----BEGIN EC PRIVATE KEY-----
```

`nas.example.internal.key` 是**通配域名的 TLS 私钥**（权限 0444/0555，本 uid 可读）。
它一旦外泄，最坏结果不是「多一个 PR」，而是**整个域的 MITM**。
建议：要么收紧该目录的可读性（别让 `app` 读得到），要么把 §3 的措辞改成
「**仓库侧**爆炸半径有界；容器可读内容的泄露面需另行治理」。

> 顺带一条同类暴露：`~/.dsh/.credentials.yaml`（DSH 模型 API key）也在容器可读范围内，
> 且经实测 **`.dsh` 本身位于 `Workspaces` 挂载之内**（见 §5 核对表），
> 所以「把东西放 `.dsh` 就安全」是错的。

---

## 4. P2 完善

1. **helper 的 stdout 只能有协议内容。** 任何调试输出写 stdout 都会污染
   credential 协议（git 会解析失败）；日志一律走 stderr 或文件。
2. **按「一个仓库」铸造，而不是 `{"repos":[…]}` 复数。** 复数是过度授权：
   调用方可以只为 A 仓库 push，却要求 B 仓库的 token。helper 应只上报
   **git 实际给的那一个 path**，broker 只铸那一个仓库，并显式传 `permissions`
   （如 `contents:write` + `pull_requests:write`）收窄，不要吃 App 的全部权限。
3. **拒绝 `protocol != https`**，并对 `path` 做严格解码/校验（拒绝 `..`、NUL、
   URL 编码绕过），避免白名单被路径变体绕过。
4. **审计与 socket 安全**：
   - 审计日志**必须落盘在容器外**（如 `/volume1/docker/git-cred-broker/audit.log`），
     记录时间、host、repo、installation id、决定（allow/deny）、token 指纹（哈希前缀），
     **绝不记录 token 本身**；建议带上 `DSH_SESSION_ID`（实测环境里可用：
     `session-d2465e08-…`）做归因，比「容器」粒度更有用；
   - 若 socket 落在 Agent 可写目录（如 `.dsh`），broker 启动时必须校验
     **路径非 symlink、非预置文件**，否则存在被抢占/替换的 DoS 与伪造面。

另：确认容器内**只有一个** credential helper（`git config --global --get-all credential.helper`
应只有 `broker`）。若同时存在 `cache`/`store`，短时 token 会被额外落盘，
与「不落盘」的设计目标冲突。

---

## 5. 断言核对表（文档 claim → 实测结论）

| 文档断言 | 位置 | 实测 |
|---|---|---|
| 容器内无 GitHub 凭据 | §1 | ✅ 无 `~/.gitconfig`、无 helper、无 token 文件/环境变量 |
| 容器内无 `python3` | §2.2.3 | ✅ 无；有 `bash` / `node v24.21.0` / `git 2.39.5` / `npm 11.19.0`；**无 `curl`** |
| 是否有 `openssl` CLI「待验证」 | §2.2.3, §7, §10.6 | ❌ **无** → bash 实现出局，**必须 Node** |
| App 私钥放挂载之外 | §2.2.4, §7 | ✅ 容器内无 `/volume1`；`/volume1/docker/…` 是可行且正确的落点 |
| 「`.dsh` 不等于安全」 | — | ⚠️ compose 是 `..:/home/app/Workspaces` + `./.dsh:/home/app/.dsh`，**`.dsh` ⊂ `Workspaces`**，别把长期材料放 `.dsh` |
| 降权到 `app` 是有效边界 | §2.1 | ✅ `CapEff=0x0`（SETUID/SETGID 仅存在于 bounding set，未生效） |
| broker 走宿主 LAN IP | §5.1, §7 | ❌ `192.0.2.10:443/3000` **timeout**；文档未验证该地址。LAN 可达性本身成立（`.1:80` OPEN），docker 网关 `172.24.0.1` 也可达 |
| 容器内不存在长期材料即安全 | §6.1 | ✅ 这条成立，且是本设计最强的部分 |
| 集中吊销 | §6.1 | ✅ 删安装/吊销 App 有效（注意 token 有效期 1 小时，见官方文档） |
| `api.github.com` 可换取 token | §5.2 | ✅ 实测 `/`→200、未认证 `/app/installations`→401（首次裸请求 403 是代理抖动，非封禁） |

---

## 6. 结论与建议的最小改造

**方案 A 保留**，但把「broker 通过 LAN 明文 HTTP + 共享密钥」这一段换成：

```
┌─ 宿主（NAS，/home/app/{Workspaces,.dsh,.dotfiles} 之外）────────────┐
│  /volume1/docker/git-cred-broker/                                  │
│    app.pem     0600 root   ← 唯一长期材料                           │
│    config.json 0600 root   ← host/仓库白名单、installation 缓存      │
│    audit.log               ← 容器不可读                             │
│  broker（Node，零依赖，常驻）                                       │
│    · RS256 JWT（iat-60s / exp≤600s / iss=client id）                │
│    · owner → installation 解析 + token 缓存（到期前 5 分钟重铸）      │
│    · 只铸「一个仓库 + 收窄 permissions」                             │
│    · unix socket（0700 目录，启动时校验非 symlink）                  │
└──────────────────────────┬────────────────────────────────────────┘
                           │ unix domain socket（宿主 uid 1026 == 容器 uid 1026）
┌──────────────────────────▼─ DSH 容器 ──────────────────────────────┐
│  git-credential-broker（Node，零依赖，装在 PATH）                   │
│    get  : 校验 protocol=https / host 白名单 / path 必填 → 精确匹配仓库 │
│    store/erase : 空实现（永不落盘）                                  │
│  git config --global credential.helper broker                       │
│  git config --global credential.useHttpPath true   ← P0-1 修复       │
└────────────────────────────────────────────────────────────────────┘
```

**验收清单（在文档 §9 基础上补充）**

- [ ] 反向：`-c credential.useHttpPath=false` → push 失败且提示该开关（P0-1）
- [ ] 反向：`http_proxy` 指向死端口 → push 仍成功（证明不经代理，P0-2）
- [ ] 反向：非白名单仓库 → 拒绝；白名单 `owner/name` **不**匹配 `owner/name-evil`
- [ ] 反向：broker 停止 → 失败快、报错清晰、**不回落**（`GIT_TERMINAL_PROMPT=0` 已设）
- [ ] 反向：`git pull/push` 后 `~/.git-credentials` 不存在、`env` 与 `git config --list` 无长期凭据
- [ ] token：存在时间 ≤ 1 小时；重复调用命中缓存而非重复铸造（查 broker 日志条数）
- [ ] 归因：审计日志能按 `DSH_SESSION_ID` 还原「谁在何时为哪个仓库签了什么」
- [ ] 治理：App **不在**任何 ruleset 的 bypass 列表；push ruleset 拦截 `**/*.key` 等路径
- [ ] 挂载：容器内 `test ! -e /volume1`，且 `find / -name 'app.pem'` 找不到

---

## 7. 剩余开放问题（替换文档 §10）

1. socket 落点：**专用 bind mount**（推荐，`Workspaces` 之外）还是复用
   `/home/app/.dsh/git-cred-broker/broker.sock`（零 compose 改动，但在 Agent 可写树内）？
2. broker 形态：宿主进程（DSM 计划任务 / systemd）还是 sidecar 容器？
   若选 sidecar，私钥要多挂进一个容器，需重新核对 §2.1 的「挂载面固定」。
3. 通配 TLS 私钥（`nas.example.internal.key`）的可读性是否收紧？（决定 §3 措辞）
4. 审计日志保留期与轮转。
5. 是否现在就为 GitLab 预留 provider 抽象（§10.7），还是一次只做 GitHub。

---

## 8. 本次评审没有做的事

- **未改动被评审文档**（该文件保持原样，本文件是并列的独立记录）。
- **未实现任何代码**，未创建 GitHub App，未触碰真实凭据。
- 未验证宿主侧（NAS）的行为：`~/.dsh`、`/volume1/docker` 的属主与权限、
  broker 进程的部署方式 —— 这些只能在容器外确认。
