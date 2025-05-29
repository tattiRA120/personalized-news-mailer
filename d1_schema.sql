CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    content TEXT,
    embedding TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
