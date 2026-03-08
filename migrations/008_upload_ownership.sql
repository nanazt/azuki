-- Add uploaded_by column to tracks table for upload ownership tracking
ALTER TABLE tracks ADD COLUMN uploaded_by TEXT REFERENCES users(id);
