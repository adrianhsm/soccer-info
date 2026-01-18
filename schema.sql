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

CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    match_time TEXT NOT NULL,
    extra_info TEXT,
    analysis TEXT,
    prediction TEXT,
    prediction_reason TEXT,
    possible_scores TEXT, -- Store as JSON string
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_predictions_user_match_time ON predictions(user_id, match_time);
