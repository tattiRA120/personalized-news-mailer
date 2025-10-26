-- Add composite index on education_logs for user_id and article_id to optimize queries filtering by user feedback
CREATE INDEX IF NOT EXISTS idx_education_logs_user_article ON education_logs (user_id, article_id);
