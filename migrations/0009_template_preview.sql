-- templates for every user (docs/API.md → Templates): preview build state (PDF in
-- $DATA/templates/{id}.pdf) and visibility; uploads start private
ALTER TABLE templates ADD COLUMN preview TEXT NOT NULL DEFAULT 'pending'
    CHECK (preview IN ('pending', 'ready', 'failed'));
ALTER TABLE templates ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
