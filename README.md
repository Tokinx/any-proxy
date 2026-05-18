# Any Proxy

基于 Bun 的轻量代理服务，支持 HTTP 转发和 WebSocket 转发。

## 特性

- 通过路径传入目标地址，自动转发请求
- 支持省略协议，默认补 `https://`
- 支持 `WebSocket` 升级转发
- 自动跟随重定向
- 以 `systemd` 服务方式运行

## 环境要求

- Linux
- `systemd`
- `root` 权限或 `sudo`
- `curl`
- `Bun`

安装脚本会在缺失时自动安装 Bun。

## 安装

```bash
bash install.sh
```

安装过程中：

- 已安装会显示当前端口，并可选择重新安装、卸载或退出
- Bun 已安装时会先检查官方最新稳定版，仅在版本落后时提示升级
- 已安装的端口会作为默认值

## 使用

安装完成后默认监听 `3000`，已有安装则优先沿用原端口。

```bash
curl 'http://127.0.0.1:3000/example.com'
curl 'http://127.0.0.1:3000/https://example.com/path?q=1'
```

WebSocket：

```js
new WebSocket('ws://127.0.0.1:3000/echo.websocket.events')
```

## 服务管理

```bash
systemctl status any-proxy
systemctl restart any-proxy
systemctl stop any-proxy
journalctl -u any-proxy -f
```

## 安装目录

- 代理脚本：`/opt/any-proxy/proxy.js`
- 服务文件：`/etc/systemd/system/any-proxy.service`

## 卸载

重新运行安装脚本，选择“卸载”即可。
