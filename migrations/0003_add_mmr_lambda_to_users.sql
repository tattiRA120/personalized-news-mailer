-- Add MMR lambda setting to users table
ALTER TABLE users ADD COLUMN mmr_lambda REAL DEFAULT 0.5;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_users_mmr_lambda ON users (mmr_lambda);
