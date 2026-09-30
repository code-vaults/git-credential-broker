# DSH 容器：实测环境事实与坑

- **状态**：verified（全部为实测结论，不是推断）
- **日期**：2026-09-30
- **范围**：`dsh` 容器（`my-project/docker-compose.yml`）的运行环境。供本仓库及同容器内其他项目复用。
- **复核方式**：每条都给了当次使用的命令，环境变化后可重跑确认。
- **⚠️ 占位值**：本笔记为了能随公开仓库发布，把内网地址与主机名替换成了留档用占位值
  （RFC 5737 的 `192.0.2.0/24`、`example.internal`）。**可达性结论未改**，只改标识；
  在本机复跑时请换回你自己的地址。

---

## 1. 挂载与身份（决定"什么能活过重建"）

| 容器内路径 | 宿主来源 | 说明 |
|---|---|---|
| `/` | btrfs docker subvolume | 容器自己的可写层 |
| `/home/app/Workspaces` | `~/Workspaces` | 全量可写共享 |
| `/home/app/.dsh` | `~/Workspaces/my-project/.dsh` | ⚠️ **位于 Workspaces 挂载之内** |
| `/home/app/.dotfiles` | `~/.dotfiles` | 宿主 dotfiles（宿主全局 gitconfig 在这里） |
| `/volume1` | — | **容器内不存在**，宿主侧路径 agent 完全够不到 |

```sh
grep -E '/home/app' /proc/self/mountinfo   # 宿主源路径
ls /volume1                                # No such file or directory
```

- **`/home/app` 本身不是挂载**：所以 `/home/app/.gitconfig`、`~/.config/...` 都是容器本地的，宿主看不到，也不会被宿主读取。
- 容器 uid == 宿主 uid == **`1026:100`**（PUID/PGID 模型；宿主文件属主就是这个 uid）。
- **`CapEff=0x0`**（`CapPrm=0`）：降权有效，agent 拿不回 root；`SETUID` 只在 bounding set 里。
- 宿主用户是 `JounQin`，宿主 home 里 `~/.gitconfig` 是 `~/.dotfiles/gitconfig` 的软链。

**最重要的一条推论**：这个容器**重建很频繁**（2026-09-30 一个下午重建 3 次），容器可写层的东西重建即丢。凡是要活过重建的，只有两个地方能放：

1. compose 的 `environment:`
2. 挂载目录（`Workspaces` / `.dsh` / `.dotfiles`）

> 踩过的坑：`~/.gitconfig`、`~/.config/git-credential-broker/*` 放在可写层，容器一重建就没了，表现为"昨天还好好的 git 配置今天没了"。修法是把配置文件放到挂载里 + 用 `GIT_CONFIG_GLOBAL` 指过去。

## 2. 运行时

**有**：`node v24.21.0`（支持原生类型擦除，直接跑 `.ts`）、`npm 11.19.0`、`corepack 0.36.0`、`git 2.39.5`、`bash`、`ssh`
**没有**：`python3`、`curl`、`openssl`、`docker`、`yarn 4`（PATH 上的 `yarn` 是 classic 1.22.22，**必须**用 `corepack yarn`）
**可写**：`/` 对 uid 1026 不可写（所以建不了 `/volume1`，也改不了 `/etc`）

```sh
for c in python3 node npm corepack git curl openssl docker; do printf '%-10s ' $c; command -v $c || echo MISSING; done
```

## 3. TLS：镜像里没有 CA 证书（已修）

**曾经的症状**：容器内一切 git HTTPS 操作失败：

```
server certificate verification failed. CAfile: none CRLfile: none
```

原因：`/etc/ssl/certs` **整个目录不存在**。Dockerfile 是

```
apt-get install -y --no-install-recommends bash git openssh-client util-linux
```

`--no-install-recommends` 让 `ca-certificates` 不会被顺带装上。

**为什么极具误导性**：Node 自带 121 个根证书（`require("node:tls").rootCertificates`），所以同一个容器里 `fetch` 正常、`git` 挂掉，看起来像应用 bug。

```sh
ls /etc/ssl/certs/ca-certificates.crt      # 之前 MISSING
node -e 'console.log(require("node:tls").rootCertificates.length)'   # 121
```

**当时的绕过**（现在不需要了）：从 Node 信任库导出 PEM 并 `git config http.sslCAInfo` 指过去 —— 现在由 `git-credential-broker setup` 自动处理。
**正解**：在镜像 apt 行加上 `ca-certificates`（已加，现在脚本会打印 "system CA bundle present"）。

## 4. 网络：必须走代理，直连是黑洞

```sh
env | grep -i proxy
# http_proxy=https_proxy=all_proxy=http://192.0.2.20:7890
# no_proxy=localhost,127.0.0.1,::1,[::1]
# NODE_USE_ENV_PROXY=1        ← Node 24 的 fetch 也遵循 *_proxy
```

- **直连 `github.com:443` 会静默挂住**（不报错、不拒绝，就是不回）——曾导致 `git ls-remote` 卡满 60s 超时。所以代理不是可选优化，是唯一出路。
- `api.github.com` 经代理可达（`GET /` → 200，未认证 `GET /app/installations` → 401）。
- **compose 用 `${http_proxy:-}` 透传**：从没有这些变量的 shell 执行 `docker compose up`，容器会拿到**空字符串** → 等于直连 → 全部外网操作静默挂住。这个坑真实发生过一次（重建后所有 git push 卡死）。要么在 compose 里写明确值，要么确保 `up` 之前 shell 里有这些变量。
- `no_proxy` 默认**不含**任何内网/宿主地址。这也是本项目选 **unix socket** 而不是 LAN HTTP 的直接原因：明文 HTTP 会把密钥和 token 送进 `192.0.2.20` 那个第三方代理进程。

## 5. 文件系统：不要依赖可执行位

- 全部 **14 个**兄弟仓库都是 `core.filemode = false`（btrfs + `synoacl` 让 git 的 exec-bit 探测失效）。强制设 `true` 也能记录，但与所有兄弟仓库不一致、可能在宿主侧产生 mode 噪音。
- 后果：`git` 提交里不会记录 `+x`。脚本要么用 `bash script.sh` / `node script.ts` 调用，要么在构建/安装时 `chmod`。
- 目录 umask 表现为 `0000`：新建文件默认偏宽松（曾见到私钥是 `777`），**关键文件要显式 `chmod`**。
- `~/Workspaces` 下有 `@eaDir` 等 NAS 元数据目录。

## 6. 会话记录：zstd 多帧，grep 会骗你

- 会话记录在 `~/.dsh/sessions/<project>/session-*.jsonl.zstd`。
- 它是**多帧 zstd**（实测一个文件 **426 帧**），不是单帧：
  - `grep` 直接搜 → 什么也找不到（压缩的）
  - `zlib.zstdDecompressSync(整个文件)` → **只解出第一帧**（实测 222 字节），看起来"里面没东西"
  - 正确做法：按 magic `28 B5 2F FD` 切帧逐帧解压

```js
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd]);   // 逐帧切分后 zstdDecompressSync
```

> 实际教训：一次性凭据（client secret）被贴进对话后，我据此误判"没有落盘"，其实**明文就在里面**（正对照：同一消息里的 client_id 也能搜到）。而 `.dsh` 位于 Workspaces 挂载之内 → 等于落在 NAS 共享上。**聊天里贴过的东西，要当作已落盘处理。**

## 7. 快速自检清单

```sh
env | grep -i proxy                                   # 不能是空串
ls /etc/ssl/certs/ca-certificates.crt                  # 必须有
stat -c '%u:%g' /home/app/Workspaces                   # 应与 id -u 一致
git config --get core.filemode                         # 预期 false
node -e 'console.log(process.version)'                 # v24.x
```
