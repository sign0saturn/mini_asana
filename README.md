# mini-asana

单机版简易 Asana —— 一个跑在自己电脑上的个人项目/装修任务追踪器。纯 Python 标准库后端 + 原生 JS 前端，无第三方依赖、无构建步骤，clone 下来即可运行。

## 特性

- **多项目**：左侧边栏新建 / 切换 / 重命名 / 删除项目，数据按项目分文件存储（`data/projects/`）
- **四种视图**：列表 / 看板 / 时间线（甘特）/ 日历，左侧边栏切换
- **列表**：行内编辑各字段（负责人、截止日期、Category、Effort、Priority）、拖拽排序与跨组移动、勾选完成
- **看板**：卡片拖拽跨列、列内排序
- **时间线**：横条拖拽改起止日期、边缘拖拽调整长度、依赖关系箭头连线（正交路由大圆弧弯）、跨天横条、单日横条、Shift/Cmd/Ctrl 多选批量平移（桌面端）、任务名标签自动避让
- **日历**：按月视图，跨天任务显示为连续横条，拖拽改日期（跨天任务整体平移）
- **Category 着色**：日历色块与时间线横条按 Category 自动配色，全视图一致
- **移动端适配**：响应式布局，触屏长按拖拽、底部弹出详情面板
- **任务详情面板**：分组、负责人、起止日期、Category/Effort/Priority、前置依赖多选、备注、链接
- **token 访问认证**（默认开启，可关闭），为公网暴露场景准备

## 快速开始

要求：Python 3.7+（只用标准库），无需 pip install。

```bash
# 启动（默认监听 127.0.0.1:8787）
python3 server.py
```

首次启动会自动创建默认项目（Default Project，含 To do / In progress 两个分组），无需准备数据文件。

浏览器打开 `http://127.0.0.1:8787`。

### 认证（默认开启）

- **首次启动自动生成** 32 位十六进制 token，写入 `data/auth_token.txt`（文件权限 600），终端会打印提示；之后启动直接读取该文件。
- 浏览器访问会先看到登录页，输入 token 进入（token 存 localStorage，下次自动带）。
- 程序访问用两种方式之一携带 token：
  - 请求头 `Authorization: Bearer <token>`
  - query 参数 `?token=<token>`
- 无 token：API 返回 `401 {"error":"unauthorized"}`，页面请求返回登录页。
- **关闭认证**（仅限本机开发）：`python3 server.py --no-auth`，或环境变量 `MINI_ASANA_NO_AUTH=1`。
- **修改端口**：`python3 server.py --port 9000`，或环境变量 `MINI_ASANA_PORT=9000`（默认 8787）。
- 想自己指定 token：启动前把目标 token 写入 `data/auth_token.txt` 即可（一行文本）。

也可以 `./start.sh` 启动（等价于 `python3 server.py`，认证开启）。

### REST API

项目：

```
GET    /api/projects                      -> {"projects": [{"id","name","task_count"}, ...]}
POST   /api/projects                      新建项目 {"name": str}
GET    /api/projects/<pid>                项目详情
PATCH  /api/projects/<pid>                重命名项目 {"name": str}
DELETE /api/projects/<pid>                删除项目（最后一个项目不可删）
```

项目作用域内的任务 / 分组（`<pid>` 为项目 id）：

```
GET    /api/projects/<pid>/tasks              -> {"project","sections","tasks"}
POST   /api/projects/<pid>/tasks              创建任务 (JSON body)
PUT    /api/projects/<pid>/tasks/<id>         更新任务字段（部分更新）
DELETE /api/projects/<pid>/tasks/<id>         删除任务
POST   /api/projects/<pid>/sections           新增分组 {"name": str}
PUT    /api/projects/<pid>/sections/<name>    重命名分组 {"name": new_name}
DELETE /api/projects/<pid>/sections/<name>    删除分组（其任务移到第一个剩余分组）
POST   /api/projects/<pid>/reorder            {"section": str, "ids": [task_id, ...]} 重排分组内顺序
```

旧版单项目路径（`/api/tasks`、`/api/sections`、`/api/reorder` 等）仍可用，自动作用于索引中的第一个项目。

所有写操作原子化持久化到对应项目的 `data/projects/<pid>.json`。

## 数据存储

- `data/projects.json`：项目索引 `{"projects": [{"id","name"}, ...]}`，数组顺序即侧边栏项目顺序。
- `data/projects/<id>.json`：每个项目一个数据文件 `{"project","sections","tasks"}`；写操作先落 `.tmp` 再 `os.replace` 原子替换。
- 全新安装：启动时自动创建默认项目。
- 从旧版（单文件）升级：启动时检测到旧版 `data/tasks.json` 会自动迁移为第一个项目，原文件改名 `data/tasks.json.migrated`，不丢数据；确认迁移无误后可自行删除该备份文件。

## 从 Asana 迁移

1. 从 Asana 导出任务数据，整理为中文键 JSON（数组），字段包括：`gid`、`任务名称`、`分组`、`负责人`、`开始日期`、`截止日期`、`已完成`（"是"/""）、`Category`、`Effort`、`Priority`、`前置依赖`（任务名，以 `;` 分隔）、`任务链接`。
2. 把该文件命名为 `asana_tasks_full.json`，放在**项目目录的上一级**（convert.py 读取 `../asana_tasks_full.json`）。
3. 运行 `python3 convert.py`，生成 `data/tasks.json`；无法解析的依赖名会以 WARN 打到 stderr。
4. 启动 server：生成的旧版单文件会在首次启动时按上节所述自动迁移为第一个项目。

## 目录结构

```
mini-asana/
├── server.py            # 后端：REST API + 静态文件 + token 认证（纯标准库）
├── start.sh             # 便捷启动脚本
├── convert.py           # Asana 导出 JSON -> data/tasks.json 转换器
├── static/
│   ├── index.html       # SPA 入口
│   ├── app.js           # 前端全部逻辑（原生 JS，无构建）
│   └── style.css
├── data/                # 运行后生成（gitignore，不入库）
│   ├── projects.json    # 项目索引
│   ├── projects/        # 每个项目一个 <id>.json
│   └── auth_token.txt   # 访问 token
└── deploy/              # 可选：macOS 常驻与公网暴露
    ├── local.miniasana.plist           # 应用本体常驻
    ├── local.miniasana-tunnel.plist    # cloudflared 隧道常驻
    ├── local.miniasana-backup.plist    # 每日备份（03:17）
    ├── local.miniasana-watchdog.plist  # 隧道看门狗（每 120s）
    ├── backup.sh
    └── watchdog.sh
```

## 部署（可选）

### macOS launchd 常驻

`deploy/` 下的 4 个 plist 假设项目放在 `~/mini-asana`，且 `backup.sh` / `watchdog.sh` 已复制到 `~/mini-asana/` 下（plist 按该路径引用）：

```bash
# 1) 替换占位用户名（也可以直接手动编辑）
sed -i '' 's/YOUR_USERNAME/'"$(whoami)"'/g' deploy/*.plist

# 2) 安装并加载
cp deploy/local.miniasana*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.miniasana.plist
# 隧道/备份/看门狗按需同样 bootstrap
```

### cloudflared 命名隧道暴露到公网

仓库中的 tunnel plist 是快速隧道（`--url`）示例；生产建议用命名隧道：

```bash
cloudflared tunnel login
cloudflared tunnel create <隧道名>
# 编辑 ~/.cloudflared/config.yml：
#   tunnel: <隧道ID>
#   credentials-file: /Users/YOUR_USERNAME/.cloudflared/<隧道ID>.json
#   ingress:
#     - hostname: <你的域名>
#       service: http://localhost:8787
#     - service: http_status:404
cloudflared tunnel route dns <隧道名> <你的域名>
# 常驻：把 tunnel plist 的参数改为 cloudflared tunnel run <隧道名> 再 bootstrap
```

公网暴露时**务必保持认证开启**（默认），token 见 `data/auth_token.txt`。

### 每日备份与隧道看门狗

- `backup.sh`：把任务数据打包到 `data/backups/`，保留最新 8 份；配合 backup plist 每日 03:17 执行。多项目布局下备份 `data/projects.json` 与 `data/projects/`（tar.gz），也兼容旧版单文件 `data/tasks.json`。
- `watchdog.sh`：每 2 分钟检测域名是否被 Cloudflare 边缘正常服务（先 DoH 取真实边缘 IP 再直连，规避 fake-ip DNS），连续 2 次失败自动 kickstart 隧道服务。两个关键参数可用环境变量覆盖：
  - `WATCHDOG_DOMAIN`：监控的域名（默认 `your-domain.example.com`，必须改）
  - `WATCHDOG_TUNNEL_LABEL`：隧道服务 label（默认 `local.miniasana-tunnel`）

## 技术要点

- **零依赖**：后端仅 Python 标准库（`http.server` 多线程、原子写 JSON、token 认证）；前端原生 HTML/CSS/JS，无 npm 无构建，改完刷新即生效
- 数据即文件：按项目分文件存储（`data/projects/<id>.json` + `data/projects.json` 索引），写操作先落 `.tmp` 再 `os.replace` 原子替换
- 时间线坐标换算、依赖连线路径规划、触屏长按拖拽（Pointer Events）均在前端手写实现
