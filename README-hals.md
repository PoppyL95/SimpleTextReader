# 易笺自托管：第 1 期

本期实现服务端原文书库、SQLite 阅读进度、浏览器缓存迁移、陪读鉴权和子路径运行。阅读排版、字体、目录、分页、无限滚动和设置继续使用上游实现；首次使用默认深色，仍可切换浅色。

划线、批注、handoff 属于第 2 期；读完卡片、档案、xlsx 导入和起草属于第 3 期，本期没有这些接口。

## 启动

需要 Node.js 20 或以上。所有安装、运行命令都在 `server/` 目录执行：

```bash
cd server
npm i && npm start
```

默认只监听 `127.0.0.1:18140`。开发时使用 `npm run dev`。锁定依赖安装可用 `npm ci`。

配置可以通过进程环境或 `server/.env` 提供；`.env` 和默认数据目录已加入忽略规则。不要提交真实书籍、阅读记录或 token。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `18140` | HTTP 与 WebSocket 端口，监听地址固定为 `127.0.0.1` |
| `BASE_PATH` | 空 | 例如 `/reader`；不能包含查询参数、`..` 或重复斜线 |
| `DATA_DIR` | 仓库的 `.reader-data/` | 建议使用仓库外的绝对路径；不能放在公开前端资源树内 |
| `TRUSTED_PROXY` | `127.0.0.1` | Express 受信代理地址/网段，可用逗号分隔 |
| `SESSION_SECRET` | 每次启动随机生成 | 可选的会话签名密钥；固定配置可避免重启使浏览器 CSRF 会话失效 |
| `HALS_TOKEN` | 未配置 | 陪读 Bearer token；未配置时全部拒绝 Bearer 请求 |
| `PUPPETEER_EXECUTABLE_PATH` | 未配置 | 仅浏览器自测使用，例如 `/usr/bin/chromium` |

没有 PostgreSQL 或 `DATABASE_URL` 启动要求。本期使用 `@libsql/client` 的 **本地 `file:` SQLite 驱动**，不连接远程数据库，也不下载 Prisma 引擎。上游 Prisma schema 已改为 SQLite、JSON 改为字符串、数据库版本查询已去掉 PostgreSQL 专用语句；原有云端加工模块保留供后续复用，本期的原文服务不依赖这些模块。文本加工和分页仍复用上游前端/共享模块。不要用旧的 Prisma 命令代替本期的自动建表流程。

安装默认不下载 Puppeteer 浏览器，小服务器运行阅读器不需要 Chromium。其他第三方字体库和脚本均来自仓库；上游网络字体仍为可选，未新增 CDN。

## 子路径与网关约定

```bash
BASE_PATH=/reader DATA_DIR=/absolute/path/reader-data npm start
```

`/reader` 会 301 到 `/reader/`。nginx 必须**保留前缀**转发，包含 WebSocket 的 `/reader/ws`，设置原始 `Host` 和可信的 `X-Forwarded-Proto`。例如 upstream URI 不追加会剥离前缀的路径：

```nginx
location /reader/ {
    # 此 location 必须处于你已有的登录网关保护之下。
    proxy_pass http://127.0.0.1:18140;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # X-Reader-User 必须由网关的已登录身份覆盖，不能透传客户端输入。
    proxy_set_header X-Reader-User $remote_user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

登录网关由部署者提供，应用不提供独立账号系统。缺少 Bearer 时默认读者；只从受信代理采信 `X-Reader-User`。错误或格式错误的 Authorization 一律 401，不能降级成读者。

浏览器写请求要求 Origin/Referer 与当前站点同源；没有这些头的工具请求需要会话 cookie 和 `/api` 返回的 `csrfToken`，通过 `X-CSRF-Token` 发送。陪读请求使用正确 Bearer，不需要浏览器会话。HTTPS 网关下会话 cookie 自动设为 Secure。

静态服务仅开放明确的前端/共享资源树和 `index.html`、`version.json`、`help.json`；书籍、服务端源码、数据库和数据目录不作静态资源。PWA manifest 的 `start_url`、`scope`、`id` 和图片地址随前缀变化。上游没有 Service Worker，本期不新增它；API 返回 `Cache-Control: no-store`，没有会缓存进度的 SW 缓存键。

## 数据与恢复

```text
DATA_DIR/
  books/<sha256>.txt     # 解码为 UTF-8 的原文，含空行
  reader.db             # SQLite：书籍元数据与阅读进度
  cache/                # 预留的可重建加工缓存
```

原文件按 UTF-8 解码（必要时检测旧编码），ID 是所得文本再编码为 UTF-8 的 SHA-256；不把 CRLF 改成 LF 后再计算 ID。同名不同内容拥有不同 ID，相同内容重复上传更新文件名/元数据。下载返回服务器保存的 UTF-8 原文。

浏览器 IndexedDB 使用内容 ID 作为缓存身份，封面仍显示真实书名和作者。书库列表在启动时从服务器取得，点开书籍时才下载原文；处理结果仍可在 IndexedDB 缓存。删除服务器书籍的 API 是显式删除；清浏览器缓存不会删除服务器数据。

停服务后备份 `books/` 和 `reader.db` 即可，恢复到同一个 `DATA_DIR` 再启动。不要在数据库写入过程中简单拷贝活动数据库。`cache/` 和浏览器缓存不需要备份。

## 进度与迁移

持久化坐标为 `{line, offset}`：原文按 `\n` 切分，行号从 **1** 开始，空行计数；offset 为该原文行内的 UTF-16 字符偏移（与 JavaScript/DOM Range 一致）。阅读器仍过滤空行并插入扉页，坐标模块维护双向映射；空行没有 DOM 节点时恢复到下一个可见段落，没有下一段则恢复上一段。

打开书籍先读取服务端进度，整个初始化/恢复期间禁止写回。真实阅读操作触发的进度 2 秒防抖上传；隐藏或关闭页面时通过 `sendBeacon` 尽力提交。待发进度先保存到本地，只有收到确认后才清除；重新联网、回到页面或定期重试时继续发送原来的时间戳。失败会显示“尚未同步”。

进度包含毫秒 Unix 时间戳 `clientUpdatedAt` 和稳定的浏览器 `deviceId`。服务器以条件更新只接受更新的真实动作，旧请求返回 409；完全相同的重试幂等成功。不取最大行号，允许回翻。不同设备应保持时钟同步；超过服务器时间 5 分钟的写入返回 400。冲突提示重新打开书籍恢复较新的服务器记录。

发现旧 IndexedDB 书籍时显示“上传到服务器”按钮。迁移上传原文并转换旧阅读器行号，已有服务器进度优先；旧记录只在迁移成功后移除，失败可重试。迁移历史进度使用低优先级时间戳，不冒充新的阅读动作。

**已经同步的数据**在换设备、清缓存后仍可恢复。离线且未同步就清缓存的那部分不保证；首次离线时也不能下载尚未缓存的书。

## 第 1 期接口

所有路径前加 `BASE_PATH`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api` | 健康检查与浏览器 CSRF token |
| GET | `/api/books` | 书单：ID、文件名、书名、作者、进度（章节/行号/百分比） |
| POST | `/api/books?filename=...&encoding=...` | 原始 txt 请求体上传；编码参数可省略，最大 50 MiB |
| GET | `/api/books/:id` | 元数据和当前进度 |
| PATCH | `/api/books/:id` | JSON `{filename?, title?, author?}` |
| DELETE | `/api/books/:id` | 删除书籍与进度 |
| GET | `/api/books/:id/download` | 下载 UTF-8 原文 |
| GET | `/api/books/:id/text?from=1&to=20` | 原文片段，范围包含两端，保留空行 |
| GET | `/api/books/:id/progress` | 当前进度 |
| PUT / POST | `/api/books/:id/progress` | `{line, offset, chapter?, clientUpdatedAt, deviceId}`；POST 支持 beacon |

陪读调用示例（token 由环境安全提供，不写进命令示例常量）：

```bash
READER_URL=http://127.0.0.1:18140/reader
curl -H "Authorization: Bearer $HALS_TOKEN" "$READER_URL/api/books"
curl -H "Authorization: Bearer $HALS_TOKEN" \
  -H 'Content-Type: text/plain' --data-binary @sample.txt \
  "$READER_URL/api/books?filename=sample.txt"
# BOOK_ID 使用上传响应中的完整 sha256。
curl -H "Authorization: Bearer $HALS_TOKEN" \
  "$READER_URL/api/books/$BOOK_ID/text?from=1&to=20"
curl -H "Authorization: Bearer $HALS_TOKEN" \
  "$READER_URL/api/books/$BOOK_ID/progress"
```

## 自测

```bash
cd server
npm test
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

API 自测会创建临时 SQLite 数据目录和随机测试 token，自行启动/停止服务，不使用部署数据库。覆盖根路径、`/reader/`、去重、同名不同书、原文空行、元数据、进度冲突与回翻、beacon、鉴权、静态隔离、WebSocket 和重启持久化。

浏览器自测使用两个独立浏览器缓存验证换设备恢复、初始化不覆盖、断网回翻后重试、旧浏览器迁移及上游分页/无限滚动；所有书籍都是脚本生成的测试文本。若本机没有 Chromium，可自行安装后设置路径；阅读服务本身不需要浏览器。xlsx/handoff 自测在相应后续交付中增加。
