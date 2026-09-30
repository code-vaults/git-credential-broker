# git-credential-broker：实现、部署与验证记录

- **状态**：verified（已实现、已部署、已对**真实 GitHub** 跑通读与写）
- **日期**：2026-09-30
- **上游**：[proposed/architecture/2026-09-30-git-credential-broker.md](../../proposed/architecture/2026-09-30-git-credential-broker.md)（原提案）
- **评审**：[proposed/architecture/2026-09-30-git-credential-broker-review.md](../../proposed/architecture/2026-09-30-git-credential-broker-review.md)（P0/P1/P2）
- **代码**：仓库根目录（TypeScript + Yarn 4 + Node 原生类型擦除，**运行时零依赖**）
- **环境前提**：见 [../environment/2026-09-30-dsh-container-facts.md](../environment/2026-09-30-dsh-container-facts.md)

---

## 1. 实际部署拓扑（本环境真实路径）

```
宿主 NAS
  /volume1/docker/git-cred-broker/
    docker-compose.broker.yml      sidecar 定义
    app/                           代码（挂载之外，agent 写不到）
    app.pem                        App 私钥 0600  ← 唯一长期凭据
    config.json                    白名单/策略 0600
    log/audit.jsonl                审计（容器读不到）
  <my-project>/.dsh/git-broker/
    broker.sock                    ← 由 sidecar 绑定
    gitconfig                      ← 容器侧 git 配置（挂载上，重建不丢）

sidecar 容器 git-cred-broker（node:24-slim）
  user 1026:100 · read_only · cap_drop ALL · no-new-privileges · 无端口
  socketPath      /run/git-broker/broker.sock      → 宿主 .dsh/git-broker/broker.sock
  privateKeyPath  /etc/git-cred-broker/app.pem     → 宿主 app.pem (ro)
  auditPath       /var/log/git-cred-broker/*.jsonl → 宿主 log/

DSH 容器 dsh
  compose environment 新增三行：
    GIT_CONFIG_GLOBAL=/home/app/.dsh/git-broker/gitconfig
    GIT_BROKER_SOCKET=/home/app/.dsh/git-broker/broker.sock
    GIT_BROKER_REQUIRE=1
  helper：/home/app/Workspaces/git-credential-broker/dist/cli/helper.js
  （helper 放在 agent 可写的 workspace 里是可以的：它不持有秘密、不授权，
    broker 才是决策方。真正拿私钥的 broker 必须在挂载之外。）
```

**链路**：容器 git → helper → unix socket（挂载）→ 宿主 sidecar → App 私钥 → GitHub。
容器内**没有**任何长期凭据；sidecar 是唯一持有者。

## 2. 与提案的偏离（每条都是实测驱动）

**`init` 的 `--mode`：一个不能省的开关。** `config.json` 里的路径由**读它的那个 broker 进程**解析。
宿主进程看到的是宿主文件系统，sidecar 只看到它 `volumes:` 挂载进来的东西 —— 同一份文件在两种部署下
含义不同，所以**一份配置服务不了两种部署**。原先两个脚本各写各的路径（host-setup.sh 写宿主路径，
deploy-sidecar.sh 写容器内路径）就不会有这个问题；把两者合并成一个 `init` 时我漏了这件事，于是
`init` 记录宿主路径、`compose` 却按容器路径挂载 —— **sidecar 起不来（读不到自己的私钥）**。
现在两种模式的路径由 `src/commands/deployment.ts` 单点定义，`init --mode` 与 `compose` 都从那里取，
并有交叉测试钉住；sidecar 模式下传了冲突的 `--socket-path` 会直接报错而不是静默记下。

| 提案 | 实际实现 | 理由 |
|---|---|---|
| broker 走 **LAN HTTP + 共享密钥** | **unix domain socket** | 容器 `all_proxy` 指向另一台机器，明文 HTTP 会把共享密钥与 token 送进第三方进程。socket 不受代理影响、不暴露端口、无需 TLS/防重放。共享密钥随之取消 |
| helper 自己判定 `protocol == https` | **broker 侧按 host 判定**（`allowInsecureHttp`，默认 false） | 策略必须落在 agent 改不到的地方。helper 只拒绝它无法理解的协议 |
| 隐含假设 helper 能拿到目标仓库 | 缺 `path` **直接拒绝**，并提示开 `credential.useHttpPath` | 实测 git 默认**不传** path；不拒绝就退化成按 host 粒度签发 = 把 App 能碰到的所有仓库都授权出去 |
| 未提 token 复用 | 按 `(installation, repo)` 缓存，临近过期（默认 300s）重铸 | 一次 push 会多次调用 helper。审计实测：**1 次铸造 + 3 次缓存命中** |
| 未提权限校验 | 首次铸造前 `GET /app` 预检 | 请求 app 未授权的权限会被回 **422**，在 push 中途炸且难以定位 |
| 未提 socket 路径发现 | `--socket` > `GIT_BROKER_SOCKET` > `$HOME/.config/git-credential-broker/socket` | git 常由**非登录 shell** 启动，只靠环境变量会表现为"莫名其妙不能用" |
| §7「openssl 待验证」 | 实测**没有 openssl**；用 `node:crypto` 签 RS256 | 也顺带做到零运行时依赖 |
| 未提 TLS | 镜像缺 `ca-certificates`（已修） | 见环境笔记 §3 |

## 3. 实测过的 GitHub App 事实

- installation token 的 `repositories` 传**仓库名**（不是 `owner/name`）；也可用数字 `repository_ids`；上限 500。
- `permissions` 必须是 app 自身授权的**子集**，否则 422。
- JWT：`RS256`、`iat` 往前 60s、`exp ≤ 600s`、`iss` 用 **client ID**（官方推荐，优先于 app ID）。
- **client secret 完全不需要** —— 它属于 OAuth user-to-server 流程。本项目任何地方都不用它（曾经被误当作配置项贴出来，见环境笔记 §6）。
- **没有列出 App 私钥的 API** → 撤销无法程序化验证，只能人眼在 App 设置页确认。
- 422 `There is at least one repository that does not exist or is not accessible to the parent installation` 对**"仓库不存在"和"未被 installation 授权"完全相同**。而且 `repository access: all` ≠ "任意名字都行"，它只覆盖**已存在**的仓库。唯一可靠的区分方式：用 installation token 枚举 `/installation/repositories`（`git-credential-broker diagnose` 就干这个）。
- **没有列出 App 私钥的 API** → 撤销无法程序化验证，只能人眼在 App 设置页确认。

本环境的 App：`git-credential-broker`，id `5138420`，client_id `Iv23lifamTDN4XTLvLuk`，owner 组织 `code-vaults`，installation `166588823`，权限 `contents:write` + `metadata:read` + `pull_requests:write`。

## 4. 验证证据（都真实跑过）

- `corepack yarn check` → **81 个测试全过**（72 单元 + 9 端到端）。端到端用真实 `git http-backend` + Basic 鉴权，且**全程带着指向死端口的代理环境**——任何退回 HTTP 的改动都会失败。
- 真实 push：`[new branch] main -> main`，随后 `a6d393f..73a81f7  main -> main`；远端 `refs/heads/main` 与本地 HEAD 一致。
- 写权限：向临时分支 push 再删除，均成功（多次，含容器重建后的全新容器）。
- **容器重建后零配置自愈**：重建后不跑任何 setup，直接 `git ls-remote` / `git push` 成功；再加 `HOME=/nonexistent-home` 仍成功 → 证明不依赖容器可写层的任何文件。
- 审计日志（宿主侧）：每条含时间、host、repo、**DSH session id**、token 指纹、过期时间与 `cached` 标志；**从不含凭据本身**。
- 隔离验证：目标仓库尚未创建时，对已存在仓库成功铸造（证明整条链可用），对目标仓库 422（证明问题在 GitHub 侧而非本系统）。
- 已知 bug 与其修复见 [README.md](../../../../README.md) 的 "Verified behaviour"。

## 5. 运维手册

五个 shell 脚本已全部改成 CLI 子命令，并随包发布到 npm（`git-credential-broker`）：`setup`
（原 container-setup.sh）、`init`（原 host-setup.sh）、`compose`（原 deploy-sidecar.sh 的
compose 生成）、`probe`、`diagnose`。宿主不再需要 checkout 或构建 —— `compose` 产出的 sidecar
直接 `npx` 拉取已发布的包。同一个 bin 既是 git 的 credential helper（`get|store|erase`），
也是管理 CLI。

```sh
# 自检（不 push，不打印凭据，只给指纹）
git-credential-broker probe --socket /home/app/.dsh/git-broker/broker.sock \
  --host github.com --repo <owner/repo>

# App 安装范围 / 权限诊断（唯一能区分 422 两种成因的工具）
git-credential-broker diagnose --config /volume1/docker/git-cred-broker/config.json

# sidecar
docker compose -f /volume1/docker/git-cred-broker/docker-compose.broker.yml ps|logs|restart|down

# 每次签发
tail -f /volume1/docker/git-cred-broker/log/audit.jsonl
```

**改动后的重启顺序**：改 `config.json` → `docker compose ... restart`；换私钥 → 覆盖 `app.pem` 后 restart。

## 6. 未决 / 待确认

1. **旧私钥是否真的撤销**：文件已删，无法再用它签 JWT 探测；GitHub 也无 API 列出 App 私钥。需人工在 App 设置页确认只剩与 `app.pem` 对应的那一把。
2. `/volume1/public/certificates/` 里那份私钥副本仍在（按用户要求先不管）。**目录名带 public 却是私钥**，建议确认部署稳定后删除（broker 用的是自己 0600 的副本）。
3. `~/Workspaces/git-credential-broker/dist` 是 gitignore 的构建产物，也是 helper 的运行路径。若被清理，需在容器内 `corepack yarn build` 重建。
4. 若将来要让 agent 直接开 PR，配置里把 `pull_requests: write` 加上（App 已授权）；主干防护仍需另有 ruleset，且要确认该 App **不在** ruleset 的 bypass 列表里。
