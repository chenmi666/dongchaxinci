const OpenAI = require('openai');
const config = require('./config');

const SYSTEM_PROMPT = `你是一个创业机会识别专家。给定一个关键词及其在Google Trends上的趋势数据，
请判断该关键词属于以下哪一类：

1. 事件型热词 (event-driven) — 由突发事件、新闻、节日、娱乐事件驱动，
   热度会在短期内快速上升后回落，不具备长期商业价值。
   例："超级碗"、"地震"、"奥斯卡"、"某明星绯闻"

2. 长期需求型 (long-term demand) — 反映持续的用户需求、新兴技术、
   生活方式变化，具有创业机会潜力。
   例："远程办公工具"、"AI简历优化"、"植物肉食谱"、"在线心理辅导"

请严格按照以下JSON格式返回，不要包含其他文字：
{
    "is_event_driven": true/false,
    "opportunity_score": 0-100,
    "reasoning": "简短理由（20字以内）",
    "relook_days": 7
}

评分标准:
- 0-20: 无创业机会
- 21-40: 小众需求
- 41-60: 有一定潜力
- 61-80: 好的创业方向
- 81-100: 极佳的创业机会`;

class AIAnalyzer {
  constructor(db) {
    this.db = db;
    this._initClient(db);
  }

  _initClient(db) {
    const apiKey = config.getAiApiKey(db);
    const apiBase = config.getAiApiBase(db);
    this.apiKey = apiKey;
    this.model = config.getAiModel(db);
    this.apiBase = apiBase;
    this.client = apiKey ? new OpenAI({ apiKey, baseURL: apiBase }) : null;
  }

  isConfigured() {
    return !!(this.apiKey && this.client);
  }

  reinitialize(db) {
    this._initClient(db);
  }

  async analyzeKeyword(keyword, category, firstSeen, lastSeen, peakScore, daysActive, scoreTrend) {
    if (!this.isConfigured()) {
      return {
        is_event_driven: false,
        opportunity_score: 50,
        reasoning: 'AI未配置，默认中等评分',
        relook_days: 7,
      };
    }

    const userPrompt = `请分析关键词「${keyword}」(分类: ${category})，趋势数据如下:
- 首次出现: ${firstSeen}
- 最近出现: ${lastSeen}
- 活跃天数: ${daysActive}
- 历史峰值分: ${peakScore}
- 近期趋势: ${scoreTrend}`;

    const kwargs = {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: config.defaults.AI_MAX_TOKENS,
      temperature: config.defaults.AI_TEMPERATURE,
    };

    try {
      const resp = await this.client.chat.completions.create(kwargs);
      const text = resp.choices[0].message.content.trim();
      const data = JSON.parse(text);
      return {
        is_event_driven: !!data.is_event_driven,
        opportunity_score: parseInt(data.opportunity_score, 10) || 0,
        reasoning: String(data.reasoning || ''),
        relook_days: parseInt(data.relook_days, 10) || 7,
      };
    } catch (e) {
      return {
        is_event_driven: false,
        opportunity_score: 40,
        reasoning: `AI分析异常(${(e.message || '').slice(0, 30)})`,
        relook_days: 1,
      };
    }
  }

  async analyzeKeywordsBatch(keywordsList) {
    const results = [];
    for (const kw of keywordsList) {
      let trendScores = [];
      if (this.db) {
        const history = this.db.getTrendHistory(kw.id, 7);
        trendScores = history.map(h => h.interest_score).filter(s => s);
      }

      let scoreTrend = 'stable';
      if (trendScores.length >= 2) {
        if (trendScores[trendScores.length - 1] > trendScores[0]) scoreTrend = 'rising';
        else if (trendScores[trendScores.length - 1] < trendScores[0]) scoreTrend = 'falling';
      }

      const first = kw.first_seen || new Date().toISOString().slice(0, 10);
      const last = kw.last_seen || new Date().toISOString().slice(0, 10);
      let daysActive = 1;
      try {
        daysActive = Math.max(1, Math.round(
          (new Date(last) - new Date(first)) / 86400000
        ));
      } catch (_) {}

      const result = await this.analyzeKeyword(
        kw.keyword,
        kw.category_name || '',
        first,
        last,
        kw.peak_score || 0,
        daysActive,
        scoreTrend,
      );
      result.keyword_id = kw.id;
      result.keyword = kw.keyword;
      results.push(result);
    }
    return results;
  }
}

module.exports = AIAnalyzer;
