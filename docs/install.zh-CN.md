# systemd 安装与管理

[English](install.md) | **简体中文**

`install.sh` 同时是首次安装脚本和已安装状态下的管理菜单。

## 安装路径

| 用途 | 路径 |
|------|------|
| 代理脚本 | `/opt/any-proxy/proxy.js` |
| 服务文件 | `/etc/systemd/system/any-proxy.service` |
| 白名单文件 | `/etc/any-proxy.allowlist` |

## 安装流程

1. 检测是否已安装；已安装则进入管理菜单（重装、查看/添加/删除白名单、卸载）
2. 检测 Bun，缺失则自动安装；存在但落后于官方稳定版时提示升级
3. 询问端口（已安装则带出现有端口为默认值）
4. 首次安装时可选配置 HTTP/HTTPS 白名单
5. 写入 `proxy.js`、生成 systemd unit、enable + restart 服务

若本地没有 `proxy.js`，脚本会从 `PROXY_JS_URL` 下载，默认指向上游仓库。fork 后如需指向自己的版本：

```bash
PROXY_JS_URL="https://your-host/proxy.js" bash -c "$(curl -sSL https://your-host/install.sh)"
```

## 显示语言

脚本默认英文，传入 `zh-CN` 切换为中文，未知值回退英文。

```bash
# 命令行参数（curl 一键安装时需要用 `_` 占位 $0）
bash -c "$(curl -sSL .../install.sh)" _ --lang=zh-CN

# 或通过环境变量
ANY_PROXY_LANG=zh-CN bash -c "$(curl -sSL .../install.sh)"

# 本地文件
bash install.sh --lang=zh-CN
```

优先级：`--lang` 参数 > `ANY_PROXY_LANG` 环境变量 > 默认英文。

## 白名单管理

- 仅作用于 HTTP/HTTPS 请求，WebSocket 升级不受限制
- 列表为空时默认允许所有 IP
- 支持单 IP 和 CIDR，如 `192.168.1.10`、`192.168.0.0/16`、`10.0.0.0/24`，IPv4/IPv6 均可
- 记录保存在 `/etc/any-proxy.allowlist`，重新运行 `install.sh` 可交互式增删

修改白名单后会写回文件，但需要**重新运行 `install.sh`**（或手动重启服务）才能让新的 `ALLOWLIST` 环境变量被 systemd 加载生效。

## 卸载

重新运行 `install.sh`，在菜单中选择「卸载」。脚本会：

- 停止并 disable `any-proxy.service`
- 删除 `/etc/systemd/system/any-proxy.service`
- 删除 `/opt/any-proxy/`
- 删除 `/etc/any-proxy.allowlist`
- 执行 `systemctl daemon-reload`

## 运行要求

- Linux + systemd
- root 或 sudo
- `curl`（用于下载 Bun 或远程 `proxy.js`）
- Bun（缺失时脚本会自动安装）
