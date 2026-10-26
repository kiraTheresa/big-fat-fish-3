#!/usr/bin/env bash
set -euo pipefail
umask 077

# 路径变量用于隔离测试；Compose 使用默认路径。
config_dir=${NAPCAT_CONFIG_DIR:-/app/napcat/config}
machine_id_file=${NAPCAT_MACHINE_ID_FILE:-/etc/machine-id}
dbus_id_file=${NAPCAT_DBUS_ID_FILE:-/var/lib/dbus/machine-id}
: "${ONEBOT_ACCESS_TOKEN:?ONEBOT_ACCESS_TOKEN must not be empty}"
if [[ -n ${ACCOUNT:-} && ! ${ACCOUNT} =~ ^[0-9]+$ ]]; then
    echo 'NAPCAT_ACCOUNT must contain only digits' >&2
    exit 1
fi
mkdir -p "$config_dir"

# 独立持久化身份；迁移已有部署时可预先保存原 machine-id 到此文件。
identity="$config_dir/.machine-id"
if [[ ! -f "$identity" ]]; then
    tr -d '-' < /proc/sys/kernel/random/uuid > "$identity"
fi
if ! grep -Eq '^[a-f0-9]{32}$' "$identity"; then
    echo 'Invalid persisted machine-id; refusing to replace the saved identity' >&2
    exit 1
fi
cat "$identity" > "$machine_id_file"
if [[ -e "$dbus_id_file" && ! "$dbus_id_file" -ef "$machine_id_file" ]]; then
    cat "$identity" > "$dbus_id_file"
fi

temp_file=''
trap 'if [[ -n "$temp_file" ]]; then rm -f "$temp_file"; fi' EXIT
configure_ws() {
    local file=$1 source=$1
    # 缺失账号配置以默认配置为基础；已有配置保留其余网络和扩展字段。
    if [[ ! -f "$source" ]]; then source="$config_dir/onebot11.json"; fi
    if [[ ! -f "$source" ]]; then source=/dev/null; fi
    temp_file=$(mktemp "$config_dir/.onebot.XXXXXX")
    # token 通过环境读取，避免出现在命令参数和日志中。
    jq -s '
      (if length == 0 then {} else .[0] end)
      | if type != "object" then error("OneBot config must be an object") else . end
      | .network //= {}
      | .network = ({httpServers: [], httpSseServers: [], httpClients: [],
          websocketServers: [], websocketClients: [], plugins: []} + .network)
      | .network.websocketServers //= []
      | [.network.websocketServers[] | select(.name == "bot-core" or (.port | tostring) == "3001")] as $matches
      | if ($matches | length) > 1 then error("Multiple bot-core/3001 WS servers; resolve the conflict first") else . end
      | (($matches[0] // {}) + {
          name: "bot-core", enable: true, host: "0.0.0.0", port: 3001,
          reportSelfMessage: false, enableForcePushEvent: true,
          messagePostFormat: "array", token: env.ONEBOT_ACCESS_TOKEN,
          debug: false, heartInterval: 30000
        }) as $server
      | .network.websocketServers = ([.network.websocketServers[]
          | select(.name != "bot-core" and (.port | tostring) != "3001")] + [$server])
    ' "$source" > "$temp_file"
    if [[ -f "$file" ]] && cmp -s "$file" "$temp_file"; then
        rm -f "$temp_file"
    else
        # 首次变更前备份，重复启动不覆盖原始备份。
        if [[ -f "$file" && ! -f "$file.before-fish-init" ]]; then
            cp -p "$file" "$file.before-fish-init"
        fi
        mv "$temp_file" "$file"
    fi
    temp_file=''
}

# 新账号从默认配置继承；已选账号有独立文件，必须同时更新。
configure_ws "$config_dir/onebot11.json"
if [[ -n ${ACCOUNT:-} ]]; then
    configure_ws "$config_dir/onebot11_${ACCOUNT}.json"
fi
echo '[fish-init] Persistent identity ready; authenticated WebSocket configured on port 3001'
