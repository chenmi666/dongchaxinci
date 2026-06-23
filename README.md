# Trend Opportunity Radar

> **v2.0.0** — Node.js + SQLite + AI

每日自动抓取 Google Trends（US 地区、7天内、Business、Technology、Health），通过 AI 过滤事件型热词，识别长期需求型关键词，并生成创业机会报告。

## 功能

- **自动抓取** — 每天定时拉取 Google Trends 3 个分类的热词
- **AI 分析** — 调用大模型判断关键词是"事件型热词"还是"长期需求"，给出机会评分 0-100
- **90 天追踪** — 记录每个关键词的兴趣分数变化，画出趋势曲线
- **每日报告** — 自动生成 Markdown 报告，Top 20 创业机会排行
- **Web Dashboard** — 零配置浏览器界面，支持 CSV 导出

## 快速开始

### 1. 安装

```bash
npm install
```

### 2. 启动

```bash
# 推荐
npm start

# 开发模式（热重载）
npm run dev
```

浏览器打开 **http://localhost:8000**

### 3. 配置

首次打开会自动跳转到设置页面 `/settings`，填入：

| 字段 | 说明 |
|------|------|
| API Key | 你的 OpenAI / GLM API Key |
| API 地址 | GLM: `https://open.bigmodel.cn/api/paas/v4/`，OpenAI: `https://api.openai.com/v1` |
| 模型 | 默认 `glm-5.2`，可选 `gpt-4o-mini` 等 |
| HTTP 代理 | 如果 Google Trends 访问受限，填写代理地址（如 `http://127.0.0.1:10808`） |

### 4. 触发抓取

配置完成后，在主面板点击 **「立即同步」** 按钮，或等待每日定时任务自动执行。

### 5. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8000` | 服务端口 |
| `STARTUP_LOG` | `data/startup.log` | 启动日志路径 |
| `DATABASE_PATH` | `data/trends.db` | 数据库路径 |

## 调试

当服务运行时：

| 路由 | 说明 |
|------|------|
| `/debug` | 启动状态、内存日志、数据库统计 |
| `/log` | 启动日志文件内容（文件系统级） |

容器启动崩溃时可通过 `/log` 查看完整启动日志。

## 部署

### Zeabur

```json
{
  "startCommand": "node web/server.js"
}
```

### 独立服务器

```bash
node web/server.js
```

## 技术栈

| 组件 | 选型 |
|------|------|
| 后端 | Node.js + Express.js |
| 数据库 | SQLite (better-sqlite3, WAL 模式) |
| AI | OpenAI SDK（支持任意兼容接口） |
| 趋势数据 | google-trends-api |
| 调度 | node-cron |
| 前端 | EJS + Bootstrap 5 + Chart.js |

## 项目结构

```
├── package.json            # 依赖管理与版本
├── app/
│   ├── config.js           # 配置管理（端口、路径、AI 设置）
│   ├── database.js         # SQLite CRUD（兼容 v1 数据）
│   ├── trends-fetcher.js   # Google Trends 抓取（3种降级策略）
│   ├── ai-analyzer.js      # AI 分析
│   ├── reporter.js         # 报告生成
│   └── scheduler.js        # node-cron 每日调度
├── web/
│   ├── server.js           # Express 路由 + 启动日志
│   ├── views/              # EJS 模板（7页）
│   └── static/             # CSS
└── data/
    ├── trends.db           # SQLite 数据库（v1/v2 兼容）
    ├── startup.log         # 启动日志
    └── raw/                # 原始 CSV 备份
```

## 页面一览

| 路由 | 说明 |
|------|------|
| `/` | 主面板 — 机会评分排行、趋势上升、抓取日志 |
| `/keyword/{id}` | 关键词详情 — 90 天曲线、AI 分析记录 |
| `/reports` | 每日报告列表 |
| `/report/{date}` | 报告详情 |
| `/history` | 历史关键词浏览 |
| `/settings` | 系统设置 |
| `/debug` | 启动诊断 |
| `/log` | 启动日志文件内容 |

## API 一览

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/dashboard` | 主面板数据（含分类筛选） |
| GET | `/api/stats` | 系统统计 |
| GET | `/api/keyword/{id}` | 关键词详情 + 趋势 + AI分析 |
| GET | `/api/keyword/{id}/trend` | 关键词趋势数据 |
| GET | `/api/history` | 历史关键词搜索/筛选 |
| GET | `/api/reports` | 每日报告列表 |
| GET | `/api/fetch-logs` | 抓取日志 |
| GET | `/api/export/csv` | 导出机会 CSV |
| POST | `/api/settings` | 保存设置 |
| POST | `/api/settings/test` | 测试 AI 连接 |
| POST | `/api/trigger-fetch` | 手动触发抓取+分析 |

## 从 v1 迁移

v2 使用 Node.js 重写，数据层完全兼容 v1（Python 版）的 SQLite Schema。
现有 `data/trends.db` 可直接使用，无需迁移。
