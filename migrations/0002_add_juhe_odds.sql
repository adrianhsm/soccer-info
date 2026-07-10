-- Migration: Add odds column to juhe_matches
-- 2026-06-28
-- syncOddsFromFiro requires this column to write Firo odds into juhe_matches

ALTER TABLE juhe_matches ADD COLUMN odds TEXT;
