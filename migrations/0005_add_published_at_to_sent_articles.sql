-- 0005_add_published_at_to_sent_articles.sql

-- sent_articles テーブルに published_at カラムを追加
ALTER TABLE sent_articles
ADD COLUMN published_at TEXT;
