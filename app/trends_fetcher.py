import time
import csv
from datetime import date
from pathlib import Path

from pytrends.request import TrendReq
from app.config import settings, RAW_DIR


class TrendsFetcher:
    def __init__(self):
        self.geo = settings.TRENDS_GEO
        self.timeframe = settings.TRENDS_TIMEFRAME
        self.max_kw = settings.TRENDS_MAX_KEYWORDS
        self._client = None

    def _get_client(self):
        if self._client is None:
            kwargs = {"hl": "en-US", "tz": 360, "timeout": 8}
            proxy = settings.get_proxy()
            if proxy:
                kwargs["proxies"] = {"https": proxy, "http": proxy}
            self._client = TrendReq(**kwargs)
        return self._client

    def fetch_category_trends(self, category_name, category_id):
        pt = self._get_client()
        results = []

        # Approach 1: daily trending searches
        try:
            df = pt.trending_searches(pn="united_states")
            if df is not None and not df.empty:
                now = date.today().isoformat()
                for i, row in df.head(self.max_kw).iterrows():
                    keyword = str(row.iloc[0]).strip()
                    if not keyword or len(keyword) < 2:
                        continue
                    results.append({
                        "keyword": keyword,
                        "interest_score": max(0, 100 - i),
                        "rank": i + 1,
                        "category": category_name,
                        "date": now,
                    })
                return results
        except Exception:
            pass

        # Approach 2: realtime trending searches
        try:
            df = pt.realtime_trending_searches(pn="US")
            if df is not None and not df.empty:
                now = date.today().isoformat()
                seen = set()
                for _, row in df.iterrows():
                    title = str(row.get("title", "")).strip()
                    if title and len(title) >= 2 and title.lower() not in seen:
                        seen.add(title.lower())
                        results.append({
                            "keyword": title,
                            "interest_score": max(10, 90 - len(results) * 2),
                            "rank": len(results) + 1,
                            "category": category_name,
                            "date": now,
                        })
                    if len(results) >= self.max_kw:
                        break
                if results:
                    return results
        except Exception:
            pass

        # Approach 3: related queries for the category
        try:
            seed_map = {"Business": "business", "Technology": "technology", "Health": "health"}
            seed = seed_map.get(category_name, "news")
            pt.build_payload(
                kw_list=[seed],
                geo=self.geo,
                timeframe=self.timeframe,
                cat=category_id,
            )
            related = pt.related_queries()
            if related and seed in related:
                rising = related[seed].get("rising")
                if rising is not None and not rising.empty:
                    now = date.today().isoformat()
                    for i, (_, row) in enumerate(rising.head(self.max_kw).iterrows()):
                        keyword = str(row.get("query", "")).strip()
                        if not keyword or len(keyword) < 2:
                            continue
                        val = row.get("value", 0)
                        try:
                            score = min(100, int(val)) if val != "Breakout" else 85
                        except (ValueError, TypeError):
                            score = max(0, 80 - i)
                        results.append({
                            "keyword": keyword,
                            "interest_score": score,
                            "rank": i + 1,
                            "category": category_name,
                            "date": now,
                        })
                    if results:
                        return results
        except Exception:
            pass

        if not results:
            raise RuntimeError("所有抓取方式均失败")

        return results

    def fetch_all(self):
        today_str = date.today().isoformat()
        all_results = {}
        for cat_name, cat_id in settings.TRENDS_CATEGORIES.items():
            try:
                items = self.fetch_category_trends(cat_name, cat_id)
                all_results[cat_name] = items
                self._save_csv(cat_name, today_str, items)
                time.sleep(3)
            except Exception as e:
                all_results[cat_name] = []
                print(f"  [WARN] {cat_name} fetch failed: {e}")

        self._save_merged_csv(today_str, all_results)
        return all_results

    def _save_csv(self, category, date_str, items):
        dir_path = Path(RAW_DIR) / date_str
        dir_path.mkdir(parents=True, exist_ok=True)
        filepath = dir_path / f"{category.lower()}.csv"
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["keyword", "interest_score", "rank", "category", "date"])
            w.writeheader()
            w.writerows(items)

    def _save_merged_csv(self, date_str, all_results):
        dir_path = Path(RAW_DIR) / date_str
        dir_path.mkdir(parents=True, exist_ok=True)
        filepath = dir_path / "all_merged.csv"
        all_items = []
        for items in all_results.values():
            all_items.extend(items)
        all_items.sort(key=lambda x: x["interest_score"], reverse=True)
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["keyword", "interest_score", "rank", "category", "date"])
            w.writeheader()
            w.writerows(all_items)
