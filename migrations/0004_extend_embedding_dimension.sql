-- 0004_extend_embedding_dimension.sql

-- articles テーブルの embedding カラムを更新し、
-- 既存の256次元のembeddingに0.0を追加して257次元にする
UPDATE articles
SET embedding = json_insert(embedding, '$[256]', 0.0)
WHERE json_array_length(embedding) = 256;

-- users テーブルの embedding カラムを更新し、
-- 既存の256次元のembeddingに0.0を追加して257次元にする
UPDATE users
SET embedding = json_insert(embedding, '$[256]', 0.0)
WHERE json_array_length(embedding) = 256;
