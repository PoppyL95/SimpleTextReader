# 易笺自托管：第 3 期

已实现服务端原文书库、SQLite 阅读进度、浏览器缓存迁移、陪读鉴权、子路径运行、划线、页边批注串和 handoff；本期增加读完卡片、档案、xlsx 导入及陪读起草。阅读排版、字体、目录、分页、无限滚动和设置继续使用上游实现；首次使用默认深色，仍可切换浅色。


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
  reader.db             # SQLite：书籍、进度、批注、handoff、阅读统计、档案、草稿
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
| DELETE | `/api/books/:id` | 删除书籍、进度、划线、批注、统计、草稿及该书 handoff；档案保留为无原文记录 |
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

## 读完卡片与档案

读到末页末段后出现建议，可点击“继续阅读”关闭；工具栏也有“读完了”。打开卡片或到达末尾不写档案，只有点击“保存记录”才保存“已看完”及其他填写内容。书名、作者、开始/读完日期、阅读时长和字数自动填入，作者未识别时须手填。切换“未看完”会清空读完日期，日期仍可手动修改。

开始日期取首次真实阅读交互；打开、自动恢复进度及填写档案不计阅读。时长只累计页面可见且最近两分钟内有正文、目录或翻页交互的时间，卡片/档案打开期间暂停。每个阅读会话使用固定 `sessionId` 和累计 `elapsedMs`，重复或晚到的较小累计值不重复计时；离线数据存在浏览器，联网后重试。多设备同时阅读的会话分别累计，无法排除并行阅读的重叠时间。字数按非空白 Unicode 字符计数，包含标点，emoji 按一个字符计数；旧数据在首次查询时补算，开始日期不伪造。历史导入没有时长或字数时显示“未知”。

问卷选项与任务单第二版一致，统一定义在 [review-fields.js](shared/core/reader/review-fields.js)，由卡片、导入、标签和服务端校验共用。时代背景只显示对应子题，切换背景清除不再适用的选择。每个枚举选项完整作为标签（如“踩我雷点 滚”保留其中空格），补充标签按空格、英文/中文逗号拆分。

“档案”可按书或按标签查看，搜索书名/作者，并按评价、平台、背景筛选。支持新建、编辑、删除；关联原文的记录提供“去阅读”，没有 txt 的记录仍可查看/编辑。删除原文保留档案。上传同名同作者的 txt 时提示“关联原文”，只有明确点击才关联；多份同名同作者的原文在导入预览中由读者选择。手动编辑档案带 `updatedAt`，旧版本保存返回 409，保留输入供读者处理冲突。

档案可切换“卡片”和“表格”：直接展示视角、关系、背景/对应题材、故事风格和补充标签，点击标签可筛选。评级保留完整文字并区分颜色：“值得多刷”为最醒目的亮金色徽标，“可圈可点”绿色、“文荒可看”蓝色、“看不下去”灰色、“踩我雷点 滚”红色；深浅模式均可辨认。表格支持横向滚动并固定表头，手机卡片改为单列。读完卡片分为书籍与阅读、评价与人物、题材与标签、读后感四组，人工感想和小克草稿并排展示，窄屏纵向排列。保存栏独立于滚动内容，避免遮挡输入和草稿操作。展示样式限定在新增档案/卡片的对话框内。

## xlsx 导入

在档案页点击“导入 xlsx”。只读第一张工作表，首行为表头：`书名（必填）`、`作者（必填）`、问卷题目、`提交时间（自动）`、`提交者（自动）`，可额外包含 `感想`/`读后感`、`开始阅读日期`、`读完日期` 和其他原始列。所有列统一去掉末尾的 `（必填）`、`（自动）`、`（选X才出）` 等导出括注，兼容腾讯问卷的 `角色（必填）`、`古代（必填）` 等真实表头、半角括号和任务单中的 `└ 古代（选古代才出）`。多选单元格使用 `, ` 分隔，未出现的联动子题为空。

先展示行号、错误、未识别列、未知选项、重复状态和原文关联选择；确认已选行后才写档案，错误行和重复行默认不可选择。未识别的列逐行以黄色警告明确指出列名及“仅保存在原始字段，未填入问卷”，即使该行的单元格为空也提示。表外选项或不适用的联动值保留到补充标签，并以黄色提示；所有原始列和值保存于记录的 `original`，可在编辑卡片中展开查看，未知列和原始字符串空白不丢失。

以裁剪首尾空白后的（书名、作者、提交时间）去重；同文件重复行与已入库记录都跳过，重导不覆盖已有修改。提交时间统一为 UTC、按秒四舍五入，以兼容 Excel 日期单元格的浮点误差；无时区的文本按 UTC 解释，有时区的文本转换为 UTC，原始值另存。支持 Excel 日期单元格及 `2026-10-01 13:30:00`、ISO 时间文本。

文件最多 8 MiB，解压总量最多 32 MiB、1000 个条目；最多 5000 条记录、50 列、400 万文本字符。预览保存于 SQLite、30 分钟有效，只保留最近三份；过期或书籍信息变化需重新预览。导入不执行公式，只使用导出文件中的缓存值。

## 让小克起草

点击按钮创建带 `requestId` 的 `draft_request` handoff，payload 包含 `{requestId, archiveId, book, notes}`：书籍元数据、统计以及当时全部划线/批注快照。陪读端读取队列、生成草稿，再用正确 Bearer 回填；阅读器本身不调用模型或自动生成感想，陪读需自行消费该接口。

草稿独立存入 `reviewDrafts`，回填不会改变人工感想，也不隐式 ack handoff。卡片每五秒刷新当前请求；同一卡片的新请求优先于晚到旧请求。点击“采用草稿”才复制到感想框，已有文字会确认，可再修改并保存。未保存的新卡片的起草请求会在保存时关联新档案，重新打开该档案仍能看到草稿。同请求同文本回填幂等，不同文本返回 409；要重新起草应创建新请求。

## 第 3 期接口

所有路径前加 `BASE_PATH`。GET 允许读者和陪读；档案修改、导入、计时、关联和起草请求仅允许浏览器读者，草稿回填仅允许陪读。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/books/:id/stats` | `{bookId, startedAt, readingMs, wordCount}` |
| POST | `/api/books/:id/reading` | `{sessionId, startedAt, elapsedMs}`；开始时间为 Unix 毫秒，支持 beacon |
| GET | `/api/archives?q=&rating=&platform=&background=&tag=&bookId=` | 档案数组，包含 fields、tags、warnings、hasBook |
| POST | `/api/archives` | `{title, author, bookId?, startedAt?, finishedAt?, fields?, reflection?, draftRequestId?}` |
| GET | `/api/archives/:recordId` | 完整档案，含 original 原始字段 |
| PATCH | `/api/archives/:recordId` | 同创建字段及必填 `updatedAt`，防旧页面覆盖 |
| DELETE | `/api/archives/:recordId` | 删除档案 |
| POST | `/api/archive-import/preview?filename=...xlsx` | 原始 xlsx 请求体，返回 previewId、expiresAt、逐行 errors/warnings/candidates |
| POST | `/api/archive-import/commit` | `{previewId, rows:[2,3], links?:{"2":"bookId或null"}}`；返回 imported、duplicates、inserted |
| GET | `/api/books/:id/archive-candidates` | 同名同作者且未关联的档案 |
| POST | `/api/books/:id/archive-link` | `{recordIds:[1,2]}`，明确关联匹配档案 |
| POST | `/api/books/:id/draft-request` | `{archiveId?:1}`，返回 requestId、handoffId、pending 草稿 |
| GET | `/api/books/:id/review-draft?requestId=...` | 指定请求；未知请求返回 404 |
| GET | `/api/books/:id/review-draft?archiveId=1` | 该档案最新请求；`archiveId=new` 查询未保存卡片的请求，无请求返回 null |
| POST | `/api/books/:id/review-draft` | 陪读 `{requestId, draft}`，仅回填草稿 |

日期使用 `YYYY-MM-DD` 或 null；标题/作者必填，感想/草稿最多 50000 字符。`fields` 使用共享定义中的键，例如 `{rating:"值得多刷", background:"古代", ancient:["修仙"], completed:"已看完"}`，无选项时用空字符串或空数组。关联书籍的手工档案在保存时从服务器刷新时长和字数。

```bash
# 浏览器写操作示例：无 Bearer，Origin 与站点同源；生产环境还需已有登录网关会话。
curl -H 'Origin: http://127.0.0.1:18140' -H 'Content-Type: application/json' \
  --data '{"archiveId":null}' "$READER_URL/api/books/$BOOK_ID/draft-request"
# REQUEST_ID 取该响应中的 requestId，或 draft_request handoff 的 payload.requestId。
curl -H "Authorization: Bearer $HALS_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"requestId\":\"$REQUEST_ID\",\"draft\":\"虚构的读后感草稿\"}" \
  "$READER_URL/api/books/$BOOK_ID/review-draft"
curl -H "Authorization: Bearer $HALS_TOKEN" "$READER_URL/api/archives"
```

启动自动为前两期数据库增加阅读统计、会话、档案、草稿和导入预览表，已有数据不需重新上传。备份范围仍是 `books/` 和 `reader.db`。

## 自测

```bash
cd server
npm test
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
# 最小三期自测：生成样例 xlsx、预览/导入、上传 txt、写批注、取 handoff、回填草稿。
node --test test/reviews.mjs
```

API 自测会创建临时 SQLite 数据目录和随机测试 token，自行启动/停止服务，不使用部署数据库。覆盖根路径、`/reader/`、去重、同名不同书、原文空行、元数据、进度冲突与回翻、beacon、鉴权、静态隔离、WebSocket；二期增加划线/批注增改删、作者不可伪造、跨书回复拒绝、已读标记、handoff 游标分页与幂等确认，以及重启持久化。三期增加可见/两分钟计时边界、档案增改删与版本冲突、xlsx 逐行预览/去重/原始值、无原文档案及关联、起草快照、请求绑定和晚到草稿不覆盖感想。

浏览器自测使用独立浏览器缓存验证换设备恢复、初始化不覆盖、断网回翻后重试、旧浏览器迁移及上游分页/无限滚动；二期增加拖选、跨段空行/中文/emoji 坐标、划线恢复、页边批注读写、未读提示、安全展示、移动端触摸菜单、高亮兼容渲染和断网输入保留。三期验证真实交互计时、读完建议可关闭、联动选项、草稿显式采用/修改/保存、按书/标签筛选、导入确认/重导、无原文查看及显式关联、手机卡片和浅色布局。所有书籍与 xlsx 都由 [review-workbook.mjs](server/test/fixtures/review-workbook.mjs) 等脚本生成，不包含真实数据。若本机没有 Chromium，可自行安装后设置路径；阅读服务本身不需要浏览器。

移动端自动检查使用 390px 视口、Selection API 和触摸事件；系统原生长按手柄的交互需在实际手机浏览器验收。
