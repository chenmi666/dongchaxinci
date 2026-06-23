from datetime import date
from app.config import settings


class DailyReporter:
    def __init__(self, db, analyzer=None):
        self.db = db
        self.analyzer = analyzer

    def generate_daily_report(self):
        today_str = date.today().isoformat()
        total_kw = self.db.get_total_keywords()
        new_kw = self.db.get_new_keywords_count(days=1)

        long_term_kw = self.db.get_keywords_by_status("long_term")
        event_kw = self.db.get_keywords_by_status("event_driven")

        long_term_cnt = len(long_term_kw)
        event_cnt = len(event_kw)

        top_opps = self.db.get_top_opportunities(limit=settings.REPORT_TOP_N)

        lines = []
        lines.append(f"# Trend Opportunity Radar — 每日报告 ({today_str})")
        lines.append("")
        lines.append("## 今日概览")
        lines.append("")
        lines.append(f"| 指标 | 数值 |")
        lines.append(f"|---|---|")
        lines.append(f"| 关键词总数 | {total_kw} |")
        lines.append(f"| 今日新增 | {new_kw} |")
        lines.append(f"| 长期需求型 | {long_term_cnt} |")
        lines.append(f"| 事件型 | {event_cnt} |")
        lines.append(f"| AI分析次数 | {self.db.get_stats()['total_analyses']} |")
        lines.append("")

        lines.append("## Top 创业机会")
        lines.append("")
        lines.append("| # | 关键词 | 分类 | 评分 | 分析理由 |")
        lines.append("|---|---|---|---|---|")
        for i, opp in enumerate(top_opps[:10], 1):
            lines.append(
                f"| {i} | {opp['keyword']} | {opp['category_name']} | "
                f"{opp['opportunity_score']} | {opp['reasoning']} |"
            )
        lines.append("")

        lines.append("## 本周趋势上升关键词")
        lines.append("")
        rising = self.db.get_trending_up_keywords(min_days=3, limit=10)
        if rising:
            lines.append("| 关键词 | 分类 | 当前分 |")
            lines.append("|---|---|---|")
            for r in rising:
                lines.append(f"| {r['keyword']} | {r['category_name']} | {r['score_today']} |")
        else:
            lines.append("(暂无数据)")
        lines.append("")

        summary_md = "\n".join(lines)

        opp_list = []
        for opp in top_opps:
            opp_list.append({
                "keyword": opp["keyword"],
                "category": opp["category_name"],
                "score": opp["opportunity_score"],
                "reasoning": opp["reasoning"],
            })

        self.db.save_report(
            today_str, total_kw, new_kw, long_term_cnt,
            event_cnt, opp_list, summary_md,
        )

        return {
            "date": today_str,
            "total_keywords": total_kw,
            "new_keywords": new_kw,
            "long_term_cnt": long_term_cnt,
            "event_cnt": event_cnt,
            "top_opportunities": opp_list,
            "summary_md": summary_md,
        }
