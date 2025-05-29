CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    content TEXT,
    embedding TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    embedding TEXT
);

CREATE TABLE IF NOT EXISTS click_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (article_id) REFERENCES articles(id)
);

CREATE INDEX IF NOT EXISTS idx_click_logs_user_id ON click_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_click_logs_timestamp ON click_logs (timestamp);

CREATE TABLE IF NOT EXISTS sent_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    embedding TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (article_id) REFERENCES articles(id)
);

CREATE INDEX IF NOT EXISTS idx_sent_articles_user_id ON sent_articles (user_id);
CREATE INDEX IF NOT EXISTS idx_sent_articles_timestamp ON sent_articles (timestamp);

CREATE TABLE IF NOT EXISTS education_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    action TEXT NOT NULL, -- e.g., 'viewed', 'liked', 'disliked'
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (article_id) REFERENCES articles(id)
);

CREATE INDEX IF NOT EXISTS idx_education_logs_user_id ON education_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_education_logs_timestamp ON education_logs (timestamp);
