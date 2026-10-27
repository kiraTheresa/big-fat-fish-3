# NapCat 登录与自动连接

`docker compose restart napcat` 重启原容器；`docker compose up -d napcat` 在配置变化时可能重建容器。两者都复用本项目 `napcat/` 下的登录数据。保留目录并不代表 QQ 会话永不过期，手机退出设备、服务端失效或安全验证仍可能要求扫码。

## 首次部署

1. 复制 `.env.example` 为 `.env`，设置非空 `ONEBOT_ACCESS_TOKEN`（可用 `openssl rand -hex 32` 生成），填写准备登录的 `NAPCAT_ACCOUNT`。
2. 设置固定的 `NAPCAT_HOSTNAME`，之后保持不变。运行 `docker compose up -d napcat`。
3. 打开 `http://localhost:6099/webui` 完成首次扫码。没有有效登录记录时，指定账号也不能跳过扫码。
4. Bot 在宿主机使用 `npm start`，或使用 `docker compose up -d --build bot`。二选一，避免两个 Bot 同时处理消息。

正向连接方向：Bot → NapCat。容器内 Bot 连接 `ws://napcat:3001`；宿主机 Bot 使用 `.env` 的 `ONEBOT_WS_URL`，默认 `ws://localhost:3001`。Bot 已有断线自动重连，默认间隔 5 秒；NapCat 完成 QQ 登录并启动 WS 后即可接通。

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
