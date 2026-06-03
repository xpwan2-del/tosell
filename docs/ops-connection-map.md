# ToSell 运维连接真相表

本文件是 ToSell 当前生产测试环境的连接来源。后续排查数据库、生产 API、支付配置和部署状态时，优先看这里，不再使用旧云数据库资料。

## Google VM

| 项目 | 当前值 |
| --- | --- |
| 实例名称 | `instance-20260528-201526` |
| 实例 ID | `7711859730007006362` |
| 区域 | `us-central1-a` |
| 外部 IP | `35.254.163.51` |
| 内部 IP | `10.128.0.2` |
| 机器类型 | `e2-medium`，2 vCPU，4 GB 内存 |
| 系统 | Debian 12 |
| SSH 用户 | `tosell` |
| SSH 别名 | `tosell-gcp` |
| 项目目录 | `/opt/tosell/app` |

本机 SSH 配置：

```sshconfig
Host tosell-gcp
  HostName 35.254.163.51
  User tosell
  IdentityFile ~/.ssh/tosell_gcp_ed25519
  IdentitiesOnly yes
```

连接测试：

```bash
ssh tosell-gcp 'hostname; whoami; pwd'
```

期望返回：

```text
instance-20260528-201526
tosell
/home/tosell
```

## 应用运行

| 项目 | 当前值 |
| --- | --- |
| API 进程 | PM2 `tosell-api` |
| API 命令 | `node /opt/tosell/app/node_modules/.bin/tsx apps/api/src/server.ts` |
| API 监听 | `0.0.0.0:3000` |
| Web 入口 | Nginx，80/443 |
| 运行环境 | `APP_ENV=production` |
| Mock 支付 | `MOCK_PAYMENT_ENABLED=false` |
| Demo 登录 | `ALLOW_DEMO_AUTH=false` |
| 默认店铺 | `shop-1780037430967` |

## 数据库

当前生产测试数据库是 Google VM 本机 PostgreSQL，不是旧云数据库。

| 项目 | 当前值 |
| --- | --- |
| 数据库类型 | PostgreSQL 17 |
| 服务位置 | Google VM 本机 |
| 监听地址 | `127.0.0.1:5432` |
| 数据库名 | `tosell` |
| 数据库用户 | `tosell` |
| 运行时连接 | `postgresql://tosell:<password>@127.0.0.1:5432/tosell?sslmode=require` |

本地维护时先开 SSH 隧道：

```bash
ssh -N -L 15432:127.0.0.1:5432 tosell-gcp
```

本地维护连接模板：

```env
DATABASE_URL="postgresql://tosell:<password>@127.0.0.1:15432/tosell?sslmode=require"
```

数据库密码只允许保存在服务器环境或个人安全密钥库里，不写入仓库、不写入文档、不打印到日志。

## 旧环境禁用

旧云数据库是已退役的生产测试环境。后续不要再使用旧云数据库作为 ToSell 生产或生产测试数据库，也不要把旧云数据库连接串当成上线依据。

如果需要确认真实运行连接，登录 Google VM 后从当前 API 进程环境读取，不从本地旧 `.env` 推断：

```bash
PID=$(pgrep -f "apps/api/src/server.ts" | head -1)
tr '\0' '\n' < /proc/$PID/environ | sed -n 's/^DATABASE_URL=/DATABASE_URL=<redacted>/p'
```

## 安全规则

1. 不提交数据库密码、支付密钥、JWT secret、OIDC token、SSH 私钥。
2. 不在聊天、日志、文档和测试输出里打印完整密钥。
3. 不用 `.env.example` 或旧 `.env.production.local` 判断生产配置。
4. 合并、部署、迁移前必须确认目标是 `tosell-gcp` 和 Google VM PostgreSQL。
5. 所有功能测试、页面验收、API smoke 和回归签收必须使用 Google VM PostgreSQL 真库。开始前先执行 `npm run test:real-db:guard`；本地内存测试只能作为纯单元辅助，不能作为功能完成证据。
