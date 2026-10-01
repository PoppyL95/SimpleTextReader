# 易笺自托管：第 2 期

已实现服务端原文书库、SQLite 阅读进度、浏览器缓存迁移、陪读鉴权和子路径运行；本期增加划线、页边批注串和 handoff。阅读排版、字体、目录、分页、无限滚动和设置继续使用上游实现；首次使用默认深色，仍可切换浅色。

读完卡片、档案、xlsx 导入和起草属于第 3 期，本期没有这些接口。

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
  reader.db             # SQLite：书籍、进度、划线、批注与 handoff
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
| DELETE | `/api/books/:id` | 删除书籍、进度、划线、批注及该书 handoff |
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

## 划线与页边批注

电脑拖选、手机长按正文后，菜单提供“划线”“发给小克”和“批注”。划线收到服务器确认后才显示；重开书籍、换设备时从服务器恢复。高亮使用 CSS Highlight API，旧浏览器使用保持原段落/首字布局的文本标记兼容方式。

每段左侧的淡色 `+` 可添加批注；已有批注显示小圆点，小克的未读批注显示亮色圆点。点开后按创建时间和 ID 排序显示整段批注，可回复某条批注或选定划线，也可编辑/删除自己的内容。批注文字按纯文本展示。关闭阅读时标记随之关闭；打开期间每 5 秒拉取新批注。

所有批注和划线的 `author` 由服务端身份决定：浏览器为 `reader`，正确 Bearer 为 `hals`，请求体里的 `author` 被忽略。只有原作者可编辑/删除；读者可以设置已读/未读。展开批注串才明确标记其中已展示的小克批注为已读，GET、翻页和轮询不改变已读状态；小克编辑内容会重新置为未读。展开期间新到的批注仍保留未读提示，需要再次打开确认。

划线坐标为 `{startLine, startOffset, endLine, endOffset, quote}`，行号从 1 开始，偏移为 UTF-16 单位，结束偏移不包含该字符。`quote` 必须等于坐标截取的**原文**，包含跨段空行、CR 和被阅读器隐藏的字符，最大 20000 字符。字符映射处理空白裁剪、不可见字符、HTML/实体和英文首字大写；无法可靠对应原文的选区会提示重新选择，不保存错误坐标。

默认创建 comment，须提供原文 `line` 和非空 `text`（最大 10000 字符）。`parentId` 可指向同一本书的划线或批注；服务器沿用该锚点的行号，回复的回复归入同一批注串。跨书引用返回 404，冲突行号返回 400。删除锚点会连同其回复删除；界面有确认提示。划线可 PATCH 更新坐标及说明，已有回复的划线不能移动到另一行；批注的行号和父锚点不可修改。

标记保存失败会明确提示；批注输入保留在当前输入框，联网后可重试。二期批注写入没有后台离线队列，关闭输入框或页面前需确认保存成功。

## 第 2 期接口

同样在所有路径前加 `BASE_PATH`，鉴权和浏览器同源要求与一期一致。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/books/:id/notes` | 全部划线/批注数组，按 `createdAt, id` 排序；不标已读 |
| POST | `/api/books/:id/notes` | `{line, text, parentId?}`；划线用 `{kind:"highlight", startLine, startOffset, endLine, endOffset, quote, text?}` |
| PATCH | `/api/books/:id/notes/:noteId` | 编辑自己的批注 `text` 或划线坐标/说明 |
| DELETE | `/api/books/:id/notes/:noteId` | 删除自己的划线/批注及其回复 |
| POST | `/api/books/:id/notes/:noteId/read` | `{read:true}`；`false` 恢复未读，默认 `true`，仅浏览器读者 |
| POST | `/api/books/:id/notes/read` | `{ids:[1,2], read:true, versions?:{"1":"updatedAt"}}` 批量标记，最多 500 个；可用版本防止误标晚到的编辑，冲突返回 409 |
| POST | `/api/books/:id/handoff` | 读者发送选区：同划线坐标及 `chapter?`；服务器内部创建固定 `selection` 类型 |
| GET | `/api/handoff?unread=1&limit=50&cursor=123` | `{items, nextCursor}`；按自增 ID 升序，ID 大于 cursor，limit 1–200 |
| POST | `/api/handoff/:id/ack` | 确认已取，返回条目；重复调用保持同一 `acknowledgedAt` |

`handoff` 的 `payload` 保存书籍 ID、书名 `title`、作者 `author`、章节和完整选区坐标/原文摘录。读取不会确认，陪读处理成功后需显式 ack；游标为上一页 `nextCursor`，为 `null` 时当前已无下一页。省略 `unread=1` 返回全部条目。没有通用 `POST /api/handoff`：类型、身份和 payload 由发送动作在服务端生成，不接受客户端任意入队。删除书籍同时删除其队列条目。

```bash
# 陪读写批注；不需要传 author。
curl -H "Authorization: Bearer $HALS_TOKEN" -H 'Content-Type: application/json' \
  --data '{"line":3,"text":"这是测试批注"}' \
  "$READER_URL/api/books/$BOOK_ID/notes"
curl -H "Authorization: Bearer $HALS_TOKEN" "$READER_URL/api/books/$BOOK_ID/notes"
curl -H "Authorization: Bearer $HALS_TOKEN" "$READER_URL/api/handoff?unread=1&limit=50"
# HANDOFF_ID 来自 items 中的 id；处理成功后确认。
curl -X POST -H "Authorization: Bearer $HALS_TOKEN" "$READER_URL/api/handoff/$HANDOFF_ID/ack"
```

服务首次启动会为一期 SQLite 数据库自动增加 `notes`、`handoff` 表及索引，不改书籍和进度。备份范围仍为 `books/` 和 `reader.db`。

## 自测

```bash
cd server
npm test
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

API 自测会创建临时 SQLite 数据目录和随机测试 token，自行启动/停止服务，不使用部署数据库。覆盖根路径、`/reader/`、去重、同名不同书、原文空行、元数据、进度冲突与回翻、beacon、鉴权、静态隔离、WebSocket；二期增加划线/批注增改删、作者不可伪造、跨书回复拒绝、已读标记、handoff 游标分页与幂等确认，以及重启持久化。

浏览器自测使用独立浏览器缓存验证换设备恢复、初始化不覆盖、断网回翻后重试、旧浏览器迁移及上游分页/无限滚动；二期增加拖选、跨段空行/中文/emoji 坐标、划线恢复、页边批注读写、未读提示、安全展示、移动端触摸菜单、高亮兼容渲染和断网输入保留。所有书籍都是脚本生成的测试文本。若本机没有 Chromium，可自行安装后设置路径；阅读服务本身不需要浏览器。xlsx 自测随第三期交付。

移动端自动检查使用 390px 视口、Selection API 和触摸事件；系统原生长按手柄的交互需在实际手机浏览器验收。
