-- Add content_hash column to articles table without UNIQUE constraint
ALTER TABLE articles ADD COLUMN content_hash TEXT;
