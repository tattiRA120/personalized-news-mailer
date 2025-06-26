-- Step 1: 一時的なテーブルを作成して、content_hash ごとに最新のレコードを保持する
CREATE TABLE articles_unique_temp AS
SELECT *
FROM articles a
WHERE a.ROWID IN (
    SELECT MIN(b.ROWID)
    FROM articles b
    GROUP BY b.content_hash
);

-- Step 2: 元のテーブルを削除
DROP TABLE articles;

-- Step 3: 一時的なテーブルの名前を元のテーブル名に変更
ALTER TABLE articles_unique_temp RENAME TO articles;

-- Step 4: content_hash カラムに UNIQUE 制約を追加
CREATE UNIQUE INDEX idx_articles_content_hash ON articles(content_hash);
