-- Migration: Add match_type_name column to juhe_matches
-- 2026-06-28
-- Source: Juhe World Cup API (https://www.juhe.cn/docs/api/id/616)
-- 示例值: 小组赛、1/16决赛、1/8决赛、1/4决赛、半决赛、季军赛、决赛

ALTER TABLE juhe_matches ADD COLUMN match_type_name TEXT;
