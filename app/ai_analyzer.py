import json
from datetime import date, timedelta
from openai import OpenAI
from app.config import settings


SYSTEM_PROMPT = """你是一个创业机会识别专家。给定一个关键词及其在Google Trends上的趋势数据，
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
- 81-100: 极佳的创业机会"""


class AIAnalyzer:
    def __init__(self, db=None):
        self.db = db
        self.api_key = settings.get_ai_api_key(db)
        self.model = settings.get_ai_model(db)
        self.api_base = settings.get_ai_api_base(db)
        self.client = OpenAI(api_key=self.api_key, base_url=self.api_base) if self.api_key else None

    def is_configured(self):
        return bool(self.api_key) and self.client is not None

    def analyze_keyword(self, keyword, category, first_seen, last_seen,
                        peak_score, days_active, score_trend="stable"):
        if not self.is_configured():
            return {
                "is_event_driven": False,
                "opportunity_score": 50,
                "reasoning": "AI未配置，默认中等评分",
                "relook_days": 7,
            }

        user_prompt = f"""请分析关键词「{keyword}」(分类: {category})，趋势数据如下:
- 首次出现: {first_seen}
- 最近出现: {last_seen}
- 活跃天数: {days_active}
- 历史峰值分: {peak_score}
- 近期趋势: {score_trend}"""

        kwargs = dict(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=settings.AI_MAX_TOKENS,
            temperature=settings.AI_TEMPERATURE,
        )
        if "glm" not in self.model:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            resp = self.client.chat.completions.create(**kwargs)
            text = resp.choices[0].message.content.strip()
            data = json.loads(text)
            return {
                "is_event_driven": bool(data.get("is_event_driven", True)),
                "opportunity_score": int(data.get("opportunity_score", 0)),
                "reasoning": str(data.get("reasoning", "")),
                "relook_days": int(data.get("relook_days", 7)),
            }
        except Exception as e:
            return {
                "is_event_driven": False,
                "opportunity_score": 40,
                "reasoning": f"AI分析异常({str(e)[:30]})",
                "relook_days": 1,
            }

    def analyze_keywords_batch(self, keywords_list):
        results = []
        for kw in keywords_list:
            trend_scores = []
            if self.db:
                history = self.db.get_trend_history(kw["id"], days=7)
                trend_scores = [h["interest_score"] for h in history if h["interest_score"]]

            if len(trend_scores) >= 2:
                score_trend = "rising" if trend_scores[-1] > trend_scores[0] else \
                              "falling" if trend_scores[-1] < trend_scores[0] else "stable"
            else:
                score_trend = "stable"

            first = kw.get("first_seen", date.today().isoformat())
            last = kw.get("last_seen", date.today().isoformat())
            try:
                days_active = (date.fromisoformat(last) - date.fromisoformat(first)).days + 1
            except Exception:
                days_active = 1

            result = self.analyze_keyword(
                keyword=kw["keyword"],
                category=kw.get("category_name", ""),
                first_seen=first,
                last_seen=last,
                peak_score=kw.get("peak_score", 0),
                days_active=days_active,
                score_trend=score_trend,
            )
            result["keyword_id"] = kw["id"]
            result["keyword"] = kw["keyword"]
            results.append(result)

        return results
