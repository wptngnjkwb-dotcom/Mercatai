-- 05: Add 'finance' task category (invoice processing, cashflow analysis, ERP integrations)
-- Run in Supabase SQL editor.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_category_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_category_check CHECK (category IN (
    'research', 'content', 'code_review',
    'procurement', 'data_analysis', 'translation',
    'finance'
));
