# Trend Opportunity Radar

每日自动抓取 Google Trends（US 地区、7天内、Business、Technology、Health），通过 AI 过滤事件型热词，识别长期需求型关键词，并生成创业机会报告。

## 功能

- **自动抓取** — 每天 09:00 自动拉取 Google Trends 3 个分类的热词
- **AI 分析** — 调用大模型判断关键词是"事件型热词"还是"长期需求"，给出机会评分 0-100
- **90 天追踪** — 记录每个关键词的兴趣分数变化，画出趋势曲线
- **每日报告** — 自动生成 Markdown 报告，Top 20 创业机会排行
- **Web Dashboard** — 零配置浏览器界面，支持 CSV 导出

## 快速开始

### 1. 安装

```bash
cd trend-radar
pip install -r requirements.txt
```

### 2. 启动

```bash
python run.py
```

浏览器打开 **http://localhost:8000**

### 3. 配置

首次打开会自动跳转到设置页面 `/settings`，填入：

| 字段 | 说明 |
|------|------|
| API Key | 你的 OpenAI / GLM API Key |
| API 地址 | GLM: `https://open.bigmodel.cn/api/paas/v4/`，OpenAI: `https://api.openai.com/v1` |
| 模型 | 默认 `glm-5.2`，可选 `gpt-4o-mini` 等 |
| HTTP 代理 | 如果网络受限，填写代理地址（如 `http://127.0.0.1:10808`） |

### 4. 触发抓取

配置完成后，在主面板点击 **「立即同步」** 按钮，或等待每日定时任务自动执行。

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
trend-radar/
├── run.py                 # 启动入口
├── requirements.txt
├── app/
│   ├── config.py          # 配置
│   ├── database.py        # SQLite CRUD
│   ├── trends_fetcher.py  # Google Trends 抓取
│   ├── ai_analyzer.py     # AI 分析
│   ├── reporter.py        # 报告生成
│   └── scheduler.py       # 每日调度
├── web/
│   ├── main.py            # FastAPI 路由
│   ├── templates/         # Jinja2 模板
│   └── static/            # CSS
└── data/
    ├── trends.db          # 数据库
    ├── raw/               # 原始 CSV 备份
    └── export/            # 导出文件
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
