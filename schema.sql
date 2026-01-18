CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    match_time TEXT NOT NULL,
    league TEXT,
    score TEXT,
    status TEXT,
    home_logo TEXT,
    away_logo TEXT,
    UNIQUE(home_team, away_team, match_time)
);

CREATE TABLE IF NOT EXISTS juhe_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    match_time TEXT NOT NULL,
    league TEXT,
    score TEXT,
    status TEXT,
    home_logo TEXT,
    away_logo TEXT,
    UNIQUE(home_team, away_team, match_time)
);
