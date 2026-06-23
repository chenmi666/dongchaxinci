import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
EXPORT_DIR = DATA_DIR / "export"
DB_PATH = DATA_DIR / "trends.db"


class Settings:
    DATABASE_PATH: str = str(DB_PATH)

    TRENDS_GEO: str = "US"
    TRENDS_TIMEFRAME: str = "now 7-d"
    TRENDS_CATEGORIES: dict = {
        "Business": 7,
        "Technology": 5,
        "Health": 8,
    }
    TRENDS_MAX_KEYWORDS: int = 100

    AI_MODEL: str = "glm-5.2"
    AI_MAX_TOKENS: int = 500
    AI_TEMPERATURE: float = 0.3
    AI_API_BASE: str = "https://open.bigmodel.cn/api/paas/v4/"

    FETCH_HOUR: int = 9
    FETCH_MINUTE: int = 0

    REPORT_TOP_N: int = 20

    HOST: str = "0.0.0.0"
    PORT: int = 8000
    RELOAD: bool = True

    PROXY: str = ""

    @classmethod
    def get_ai_api_key(cls, db=None):
        if db:
            key = db.get_setting("ai_api_key")
            if key:
                return key
        return os.getenv("AI_API_KEY", "")

    @classmethod
    def get_ai_model(cls, db=None):
        if db:
            model = db.get_setting("ai_model")
            if model:
                return model
        return cls.AI_MODEL

    @classmethod
    def get_ai_api_base(cls, db=None):
        if db:
            base = db.get_setting("ai_api_base")
            if base:
                return base
        return os.getenv("AI_API_BASE", cls.AI_API_BASE)

    @classmethod
    def get_fetch_time(cls, db=None):
        hour = cls.FETCH_HOUR
        minute = cls.FETCH_MINUTE
        if db:
            h = db.get_setting("fetch_hour")
            m = db.get_setting("fetch_minute")
            if h:
                hour = int(h)
            if m:
                minute = int(m)
        return hour, minute

    @classmethod
    def get_proxy(cls, db=None):
        if db:
            proxy = db.get_setting("proxy")
            if proxy:
                return proxy
        return cls.PROXY


settings = Settings()
