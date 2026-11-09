# NapCat 与 Bot 部署

[← 文档目录](README.md)

`docker compose restart napcat` 重启原容器；`docker compose up -d napcat` 在配置变化时可能重建容器。两者都复用本项目 `napcat/` 下的登录数据。保留目录并不代表 QQ 会话永不过期，手机退出设备、服务端失效或安全验证仍可能要求扫码。

## 首次部署

需要 Docker 和 Docker Compose。以下命令都在项目根目录执行；已有配置请保留。

```sh
cp -n .env.example .env
cp -n config.example.json config.json
```

编辑 `.env`，配置项以 [模板](../.env.example) 为准：

| 配置 | 用途 |
| --- | --- |
| `NAPCAT_ACCOUNT`、`NAPCAT_HOSTNAME` | 准备登录的 QQ 号和固定设备主机名，部署后保持主机名不变 |
| `ONEBOT_ACCESS_TOKEN` | Bot 与 NapCat 共用的非空连接令牌，Compose 会同步到 WS 配置 |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` | 聊天、识图与记忆提炼使用的接口及模型；识图需模型支持图片输入 |
| `IMAGE_API_KEY`、`IMAGE_API_BASE_URL`、`IMAGE_MODEL` | 独立绘图接口，Key 留空则禁用绘图 |
| `ADMIN_TOKEN` | 至少 24 字符的随机工作台令牌，留空则不启动管理网站 |
| `ADMIN_QQ` | 可选，逗号分隔的肥鱼管理员 QQ 初值，用于群聊管理指令 |

模板中的模型名、接口地址和尺寸是代码默认值，不保证你的供应商支持；应按自己的接口实际填写。聊天、识图和提炼共享模型，识图要求该模型支持图片输入。

可以分别执行 `openssl rand -hex 32` 生成连接令牌和管理令牌。确认 `config.json` 是文件后启动：

```sh
docker compose up -d --build
```

Compose 默认将 NapCat 的 6099 和 3001 映射到宿主所有网络接口；肥鱼工作台 3210 仅映射回环地址。只在本机使用时可把前两项映射分别改为 `127.0.0.1:6099:6099`、`127.0.0.1:3001:3001`；只运行容器 Bot 时可移除 3001 宿主映射。

打开 [NapCat WebUI](http://localhost:6099/webui)，按页面提示登录 WebUI，再完成 QQ 首次扫码。没有有效 QQ 登录记录时，指定账号也不能跳过扫码。

配置 `ADMIN_TOKEN` 后，打开 [肥鱼工作台](http://127.0.0.1:3210) 并输入该令牌；网页默认只映射到宿主机回环地址。功能操作见 [管理说明](management.md)。

正向连接方向：Bot → NapCat。容器内 Bot 连接 `ws://napcat:3001`；宿主机 Bot 使用 `.env` 的 `ONEBOT_WS_URL`，默认 `ws://localhost:3001`。Bot 已有断线自动重连，默认间隔 5 秒；NapCat 完成 QQ 登录并启动 WS 后即可接通。

## 使用 Clash / Mihomo 分流

如果希望肥鱼直连，在已有 `rules:` 列表的顶部插入下面五条，放在 Docker 进程规则、国内规则集和 `MATCH` 之前。这样即使绘图域名解析到海外 IP，只要 Mihomo 能识别主机名，它仍然走直连。

```yaml
  - DOMAIN,api2.laozhang.ai,DIRECT
  - DOMAIN,api.deepseek.com,DIRECT
  - DOMAIN-SUFFIX,qq.com,DIRECT
  - DOMAIN-SUFFIX,qpic.cn,DIRECT
  - DOMAIN-SUFFIX,multimedia.nt.qq.com.cn,DIRECT
```

前两条对应默认绘图和聊天接口。使用自定义供应商时按实际主机名调整。绘图接口返回 Base64 时直接读取响应，返回 URL 时 Bot 还会下载图片，下载域名独立匹配规则。QQ 使用裸 IP 时也不会命中域名规则。排查时在客户端连接记录中查看目标、进程、命中规则和出口，并检查 Verge 的前置规则是否覆盖这里的顺序。

## 在宿主机开发

使用 Node.js 22.9+，保留 NapCat 容器，Bot 在容器或宿主机运行二选一。同一数据目录不能启动两个 Bot。

```sh
docker compose stop bot
docker compose up -d napcat
npm ci
# 用量分享图需要；已有可用 Chrome 时也可配置 CHROME_EXECUTABLE
npx playwright install chromium --only-shell
npm run dev
```

`npm run dev` 监视源码并重启；不需要监视时使用 `npm start`。修改 `.env` 后重新启动进程。开发与测试入口见 [架构文档](architecture.md#本地开发与验证)。

## 截图浏览器

用量页面的 PNG 分享和 QQ 用量报告由 Playwright + Chromium 截图生成。Dockerfile 使用 `node:22-bookworm-slim`，构建时安装锁定 Playwright 版本对应的 Chromium、系统依赖与中文字体；不需要在宿主另装浏览器。

宿主机运行时，在 `npm ci` 后执行 `npx playwright install chromium --only-shell`；Linux 可使用 `npx playwright install --with-deps chromium --only-shell`，并安装中文字体（Debian / Ubuntu 可用 `fonts-noto-cjk`）。也可在 `.env` 设置 `CHROME_EXECUTABLE` 指向现有 Chrome / Chromium 可执行文件。

Chromium 按需启动，不影响普通文字聊天的启动；生成报告时浏览器不可用会返回错误。依赖版本变化后使用对应版本的安装命令更新浏览器。截图内容、队列和快照限制见 [用量与报告](usage-monitoring.md#费用计价与分享图片)。

## 更新与排查

修改源码或默认 Prompt 后，运行 `docker compose up -d --build bot` 重建 Bot。只修改 `.env` 时运行 `docker compose up -d bot`；同时修改连接令牌时也需 `docker compose up -d napcat`。单纯 `restart` 不会重新加载容器环境。

如果 Docker 提示宿主的 `3210` 端口已被占用，可在 `.env` 设置 `ADMIN_PUBLISH_PORT=3211` 后运行 `docker compose up -d bot`，再访问 `http://127.0.0.1:3211`。容器内部仍监听 `ADMIN_PORT`。从宿主机 Bot 切换到容器时，先停止旧 Bot，避免两个实例同时使用 `data/` 和同一 QQ 会话。

`docker compose ps` 查看容器状态，`docker compose logs --tail=100 bot` 查看连接及启动结果。连接成功后可在 QQ 发 `ping` 检查收发链路，再按 [使用指南](usage.md) 测试聊天。只收到 `pong` 不能证明模型接口已正常工作。模型失败、发送结果未知和请求耗时的排查见 [日志与排障](observability.md)。

Bot 数据默认在 `data/`，QQ 登录数据在 `napcat/`；备份时停止 Bot 并复制完整配置和数据，自定义路径也需一起保存，具体见 [持久化说明](management.md#持久化)。

## 启动时自动完成的配置

- Compose 固定 hostname；初始化脚本把 `napcat/config/.machine-id` 恢复到 Linux 与 D-Bus 的 machine-id 文件。首次部署生成一次，后续沿用。
- `napcat/QQ` 保存 QQ 数据；`NAPCAT_ACCOUNT` 通过官方镜像的 `ACCOUNT` 参数选择快速登录账号。
- 启动前创建或更新默认 `onebot11.json`，以及所选账号的 `onebot11_<QQ号>.json`：启用 `0.0.0.0:3001` 的 WS，使用消息段数组，并同步 `.env` 的 `ONEBOT_ACCESS_TOKEN`。
- 接管名为 `bot-core` 或端口为 `3001` 的 WS 配置，保留其他服务和配置字段。出现多个匹配项时停止启动，避免产生重复监听；首次修改已有文件时保存 `.before-fish-init` 备份。
- 3001 服务由脚本管理；WebUI 对这个服务的修改会在下次启动时被同步回来。其他账号已有的独立配置不会自动修改，换账号需同时更新 `NAPCAT_ACCOUNT`。

修改 `.env` 后执行 `docker compose up -d napcat`，让容器重新接收环境变量；单纯 `restart` 不会更新容器环境。Bot 的 token 也需要重启进程或重新 `up -d bot` 才能同步。

## 已有部署迁移

首次采用本配置时，先把 `docker exec napcat hostname` 的结果保存为 `.env` 的 `NAPCAT_HOSTNAME`，并在运行容器仍存在时执行：

```sh
# 仅首次迁移且目标文件不存在时执行，保留原设备的 machine-id
test -e napcat/config/.machine-id || docker exec napcat cat /etc/machine-id > napcat/config/.machine-id
```

保留整个 `napcat/QQ` 与 `napcat/config`，不要为每次启动创建新目录。固定这些本地标识可减少环境变化，但不能保证 QQ 服务端永远认作同一设备或永不要求再次验证。

## 验证

`node --test test/napcat-init.test.js test/connection.test.js` 验证初始化、重复启动、配置保留、鉴权和模拟重连（需要 Bash 与 jq）。真实验收应检查：首次扫码 → WS 的只读 `get_login_info` / `get_status` → 重启 → 自动恢复；需要进一步确认重建时再执行 `docker compose up -d --force-recreate napcat`，复查在线状态。

官方参考：[Docker 启动脚本](https://github.com/NapNeko/NapCat-Docker/blob/main/entrypoint.sh)、[OneBot 配置](https://napneko.github.io/config/basic)。
