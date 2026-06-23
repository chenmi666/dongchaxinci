# Trend Opportunity Radar

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
pip install -r requirements.txt
```

### 2. 启动

```bash
# 方式 A（推荐）
python run.py

# 方式 B
uvicorn web.main:app --host 0.0.0.0 --port 8000
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

## Zeabur 部署

一键部署到 Zeabur，自动识别 Python + FastAPI。

1. Fork 或推送此仓库到 GitHub
2. 在 Zeabur 创建项目，关联仓库
3. 设置环境变量 `PORT=8080`（Zeabur 自动注入）
4. 可选：在 `zeabur.json` 中覆盖启动命令

```json
{
  "startCommand": "python run.py"
}
```

## 技术栈

| 组件 | 选型 |
|------|------|
| 后端 | Python + FastAPI |
| 数据库 | SQLite (WAL 模式) |
| AI | OpenAI / GLM (支持任意兼容接口) |
| 趋势数据 | pytrends |
| 调度 | APScheduler |
| 前端 | Jinja2 + Bootstrap 5 + Chart.js |

## 项目结构

```
├── run.py                 # 启动入口（uvicorn + 调度器）
├── requirements.txt
├── zeabur.json            # Zeabur 部署配置
├── app/
│   ├── config.py          # 配置管理（端口、路径、AI 设置）
│   ├── database.py        # SQLite CRUD
│   ├── trends_fetcher.py  # Google Trends 抓取（3种降级策略）
│   ├── ai_analyzer.py     # AI 分析
│   ├── reporter.py        # 报告生成
│   └── scheduler.py       # APScheduler 每日调度
├── web/
│   ├── main.py            # FastAPI 路由 + 启动日志
│   ├── templates/         # Jinja2 模板（6页）
│   └── static/            # CSS
└── data/
    ├── trends.db          # SQLite 数据库
    ├── startup.log        # 启动日志
    └── raw/               # 原始 CSV 备份
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
