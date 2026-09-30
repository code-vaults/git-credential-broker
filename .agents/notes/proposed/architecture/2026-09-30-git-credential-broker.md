# git-credential-broker 设计

- **状态**：proposed（设计阶段，未实现）
- **日期**：2026-09-30
- **范围**：让跑在 NAS 上、受网络与文件系统限制的 Agent 能向**多个 GitHub 仓库**推送，同时**长期凭据不进 Agent 所在的容器**。

---

## 1. 背景

Agent（DSH）运行在 NAS 上的 Docker 容器里，需要访问：

- **局域网**：路由器 `192.0.2.1`、NAS 自身、NAS 虚拟机
- **本地工作区**：`~/Workspaces` 下的 21 个项目

因此"把 Agent 搬到 GitHub Actions"这类方案**不适用**——runner 只能看到单个仓库，碰不到上述任何东西。执行位置是硬约束。

但容器目前**没有任何 GitHub 凭据**（已实测）：`~/.ssh` 只有 `known_hosts`、无 credential helper、无 token 文件、无环境变量 token。现状是"人推"，这不是缺陷，是当前架构的必然结果。

**本设计要解决的问题**：在保持执行位置不变的前提下，让容器内的 Agent 能够推送，且**长期凭据不落在容器可见的文件系统里**。

---

## 2. 约束

### 2.1 硬约束

| 约束 | 说明 |
|---|---|
| 执行位置固定 | Agent 必须在 NAS 容器内（要 LAN + 本地文件） |
| 挂载面固定 | `~/Workspaces` 全量可写挂载（含 `gitlab-ee/config/ssl/` 下的 `*.example.internal` 通配 TLS 私钥） |
| 运行身份固定 | 容器 root 启动后降权到 `app`(uid 1026)，可保留 `CAP_SETUID/SETGID` |
| 凭据分发 | 目标仓库分布在个人账号下（可能不止一个 owner） |

### 2.2 决定方案形态的关键事实

1. **"能跑 git 的用户"与"应当看不到长期凭据的主体"是同一个人。**
   git 由 `app` 身份执行；任何 helper 也以 `app` 身份执行。所以**文件权限无法把长期材料挡住**——只要 helper 能读，Agent 也能读。

   → 结论：**要么引入一个独立进程持有材料（方案 A），要么承认材料在 Agent 的可及范围内（方案 B）。** 没有第三条路。

2. **GitHub App 不能用于 SSH。** App 只有 installation token（HTTPS/API）。SSH 访问只能靠用户 SSH key 或 deploy key。
   → 结论：App 路线 = **HTTPS** 路线。

3. **容器内无 `python3`**（已知），有 `bash` / `node` / `git`。
   → 实现语言取 bash 或 node。
   → ⚠️ **待验证**：容器内是否有 `openssl` CLI（JWT 签名要用）。若无，可用 node 的 `crypto` 签名，绕开该依赖。

4. **长期材料不能放在项目目录里。** 项目位于 `~/Workspaces` 之下 → **会被挂载进容器**。
   → App 私钥必须放在**挂载之外的宿主机路径**。

---

## 3. 目标与非目标

**目标**

- 容器内的 Agent 能 push 到一组受控的仓库
- 长期凭据（App 私钥 / PAT）不出现在容器可见的路径中
- 凭据可集中吊销、可轮换
- 爆炸半径有界：即使凭据被滥用，最坏结果是"多一个 PR"

**非目标**

- 不允许 Agent 直接推主干（`main` 应由分支保护挡住）
- 不构建 CI / 不替代人工审阅
- 不追求 NAS 上的高可用

---

## 4. 方案空间

| 方案 | 长期材料位置 | 多仓库 | 常驻进程 | 结论 |
|---|---|---|---|---|
| **A. Broker + GitHub App** | 代理侧（容器外） | ✅ 一个 App 覆盖所有安装的仓库 | 需要 | **推荐** |
| **B. helper 自持 + 细粒度 PAT** | 容器内（Agent 可读） | ⚠️ 受限于 PAT 能力 | 不需要 | 备选 |
| C. 维持现状（人推） | 人 | — | — | 合理退路 |
| D. Actions 内推送 | GitHub 内部 | ✅ | — | ✗ **不适用**（见 4.1） |
| E. Vault / OpenBao | Vault 侧 | ✅ | 需要 | ✗ 单机不划算（见 4.2） |

### 4.1 为什么排除 D（Actions 内推送）

它确实是最干净的多仓库推送方式（`GITHUB_TOKEN` / App token，短时、按仓库），但 **Agent 必须跑在 GitHub 的 runner 上**。本项目的 Agent 需要路由器、VM、NAS 本地 21 个项目——runner 一个都碰不到。**执行位置不可迁移，故排除。**

（若将来出现"只改某个仓库并开 PR"的独立需求，那是另一个工具，不是本项目的替代品。）

### 4.2 为什么排除 E（Vault / OpenBao）

技术上可装（群晖 Container Manager 跑 `hashicorp/vault` 或 `openbao/openbao`，注意 `IPC_LOCK` / `disable_mlock` 与卷属主两个坑）。但单机单人场景下：

- 每次重启都要 unseal；自动解封要么依赖云 KMS，要么把解封密钥放在同一台机器上——后者的"密封"意义基本消失
- 还要多管 TLS、备份、升级

收益（短时 git 凭据）与 A 重叠，运维成本显著更高。**留作将来"多 Agent / 多人 / 需要集中审计"时的升级路径。**

---

## 5. 推荐设计：A（Broker + GitHub App）

### 5.1 组件

```
┌─ 宿主机（NAS，挂载之外）────────────────────────────┐
│  /volume1/docker/git-cred-broker/                  │
│    app.pem          0600 root   ← App 私钥，唯一长期材料
│    config.env       0600 root   ← 共享密钥、仓库白名单
│  broker 进程（sidecar 容器 或 宿主机 systemd/计划任务）│
│    仅监听 LAN，带共享密钥校验                        │
└──────────────────────┬─────────────────────────────┘
                       │ HTTPS/HTTP（LAN）
                       │ POST /token {repos:[…]}
                       │ ← {token, expires_at}
┌──────────────────────▼─ DSH 容器 ──────────────────┐
│  client/git-credential-broker（装在 PATH 上）      │
│    git 调用它 → 向 broker 取 token → 回给 git      │
│  容器内不存在 app.pem；token 不落盘、不常驻 env     │
└────────────────────────────────────────────────────┘
```

### 5.2 时序

1. `git push` 命中 HTTPS 远端
2. git 调用 `git-credential-broker get`，stdin 收到 `protocol=https` / `host=github.com`
3. helper 从 broker 请求 token（带共享密钥 + 目标仓库）
4. broker 校验仓库在白名单内 → 用 `app.pem` 签 JWT → `POST /app/installations/{id}/access_tokens` → 得到 installation token（**约 1 小时**，可再收窄到指定仓库与权限）
5. helper 把 `username=x-access-token` / `password=<token>` 输出给 git
6. git 完成 push；token 随进程消失（不写 `~/.git-credentials`）
7. `store` / `erase` 实现为空——不落盘

### 5.3 接口

**broker（HTTP，仅 LAN）**

```
POST /token
  Header: X-Broker-Key: <共享密钥>
  Body:   {"repos": ["owner/name", …]}
  200:    {"token": "ghs_…", "expires_at": "2026-09-30T16:05:00Z"}
  403:    仓库不在白名单
  503:    App 不可用 / 换取失败
```

**client（git credential helper 协议）**

- `get`：请求 token 并输出 `username` / `password`
- `store` / `erase`：空实现（永不落盘）

### 5.4 失败模式

| 情况 | 行为 |
|---|---|
| broker 不可达 | git 认证失败并报错，**不回落**到任何内置凭据（避免静默降级） |
| token 过期 | helper 重新请求；push 本身由 git 重试 |
| 仓库不在白名单 | broker 403，helper 输出错误 |
| App 私钥缺失/不可读 | broker 启动即失败（fail fast），不要带病运行 |

### 5.5 机器级接线（**不需要任何 per-repo 步骤**）

git 的凭据助手是**全局**机制：配一次，之后**任何仓库**的 `clone` / `fetch` / `push` 都自动走它。Agent 只需执行它本来就会的 `git push`，**不需要"知道"该怎么认证**。

```sh
# 1) 装 helper 到 PATH 并全局启用（唯一一次接线）
install -m 0755 client/git-credential-broker /usr/local/bin/
git config --global credential.helper /usr/local/bin/git-credential-broker

# 2) App token 只能走 HTTPS：若仓库用的是 SSH 远端，全局改写（同样是机器级）
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

由此推论：

- **不需要给每个仓库加 skill / 配置。** 认证是**机器级事实**，不是仓库级知识。
- 仓库级 `.agents/skills/` 只应承载**策略**（"推分支、开 PR、不许推 main"）；而策略属于 Agent 的**全局预设**，仍然不是每仓库一份。
- 接入新仓库的开销 = **0**：只要 App 安装了它、且远端是 HTTPS。

**先例（同形状，非本项目自创）**：[Catalyst 的 Environment Git 方案](https://github.com/ncrmro/catalyst/blob/main/specs/001-environments/research.git-credential-helper.md)状态为 Adopted——helper 按需向持有 App 私钥的服务端换 1 小时 token，用 `git config --global credential.helper` 全局接线，并明确**替换掉**原先"挂载 Secret"的路线。区别只在**调用方如何鉴权**：它用 K8s ServiceAccount token + TokenReview，本项目用共享密钥 + 仅 LAN。

---

## 6. 安全与威胁模型

### 6.1 本设计能防住的

- **App 私钥不进入容器**（不在任何挂载路径内）
- **无长期 token 落盘**：token 短时、按仓库、随进程消失
- **集中吊销**：删 App 安装 / 吊销 App 即可，无需逐机清理
- **身份可归因**：推送以 App 身份出现，审计日志能分辨

### 6.2 本设计**防不住**的（必须诚实记录）

1. **broker 的共享密钥本身就等价于"推送能力"。** 它存在于容器内，Agent 能读到。所以：

   > "Agent 读不到长期私钥" ≠ "Agent 不能滥用推送"

   真正的收益是：私钥不泄露、权限不越出 App 的安装范围、可集中吊销、可用量短时。**不是**"Agent 无法推不该推的东西"。

2. **有推送权限的 Agent 能把它读到的任何内容推出去。** `~/Workspaces` 是全量可写挂载（21 个项目 + `gitlab-ee` 的 TLS 私钥），这些都在它的读取范围内。

3. **分支保护是最后一道闸门，也是最重要的一道。** 若 `main` 未受保护，凭据泄露的后果从"多一个 PR"升级为"仓库被改写"。**因此必须配合**：
   - `main` / release 分支开启分支保护
   - Agent 只推 `agent/*` 之类的分支，然后开 PR
   - 不把 App 安装到不需要的仓库

### 6.3 建议的护栏清单

- [ ] App 只安装到确实需要的仓库
- [ ] App 权限只给 `Contents: read/write` + `Pull requests: write`（不给 `Administration` / `Workflows`）
- [ ] 目标仓库主干开启分支保护
- [ ] broker 只监听 LAN，绝不映射到公网
- [ ] 共享密钥一次性下发，可轮换
- [ ] 私钥文件 `0600`、属主非 `app`、位于挂载之外
- [ ] 定期检查 App 的安装范围与审计日志

---

## 7. 群晖部署要点

| 项 | 建议 |
|---|---|
| broker 形态 | sidecar 容器（Container Manager 的 compose 项目）或宿主机进程（DSM 计划任务 / systemd 容器） |
| 网络 | 容器通过宿主 LAN IP（`192.0.2.10`）访问 broker；**不要**映射到公网 |
| 私钥路径 | `/volume1/docker/git-cred-broker/app.pem`，`0600 root`——**位于 `~/Workspaces` 之外** |
| 持久化 | broker 基本无状态：只需私钥 + 配置；审计日志可选落盘 |
| 自启 | Container Manager 的 `restart: unless-stopped`，或 DSM 计划任务 |
| 依赖 | 若用 bash 实现 JWT 签名需 `openssl` CLI（**待验证容器/宿主是否具备**）；用 node 则无此依赖 |

---

## 8. 备选设计：B（helper 自持 + 细粒度 PAT）

单一脚本，容器内直接持有长期材料：

- 细粒度 PAT，限制到**选定仓库** + `Contents: write` + 短有效期（建议 7 天）
- 通过 `GIT_ASKPASS` 或 credential helper 注入，不写进 remote URL、不落盘
- 无 broker、无常驻进程

**代价**：PAT 就在 Agent 可读的路径里，且无法用文件权限补救（见 2.2 第 1 条）。

**什么时候选 B**：今天就想能推、不想多一个常驻进程、且能接受"材料在爆炸半径内"，用分支保护 + 短有效期兜住。

**从 B 升级到 A 的动机**：材料需要轮换/集中吊销、仓库变多、或想彻底把长期材料移出容器。

---

## 9. 验收标准

**功能**

- [ ] 容器内 `git ls-remote` 目标仓库成功
- [ ] 容器内 `git push` 新分支成功
- [ ] 非白名单仓库被 broker 拒绝（403）
- [ ] broker 停止时，push 失败且报错清晰（不静默降级）

**安全**

- [ ] 容器内 `find / -name 'app.pem'`（在挂载与镜像层中）**找不到** App 私钥
- [ ] `env` / `git config --list` / `~/.git-credentials` 中**没有**长期凭据
- [ ] token 存在时间 ≤ 1 小时，且不落盘
- [ ] broker 日志能显示每次签发的仓库与时间

---

## 10. 开放问题

1. **A 还是 B**——本设计推荐 A，最终选择待定
2. App 安装范围：个人账号下的**全部**仓库，还是逐个选定？（建议后者）
3. 共享密钥如何下发与轮换（一次性口令 / 手工放置 / DSM 计划任务）
4. 是否需要"按仓库区分只读/读写"
5. 是否需要把审计日志落盘，以及保留多久
6. 实现语言：bash（依赖 `openssl` CLI，**待验证**）还是 node（无额外依赖）
7. 是否需要支持 GitLab（同形态可复用，broker 增加一个 provider）

---

## 11. 参考

- [gitcredentials(7)](https://git-scm.com/docs/gitcredentials)——凭据助手协议，本设计的通用接口
- [Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token)（CI 内的同类做法，可参考其权限收窄思路）

相关记录（位于 `my-project` 仓库）：`.tasks/dsh-container/dsh-container-uid.md`——容器以宿主 uid 运行、PUID/PGID 模型与挂载边界的实测结论。
