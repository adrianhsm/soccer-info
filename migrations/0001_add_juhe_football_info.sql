-- Migration: Add football_info column to juhe_matches
-- 2026-06-13

ALTER TABLE juhe_matches ADD COLUMN football_info TEXT;
