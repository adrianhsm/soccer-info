

const fetchTodayMatches = async (env) => {
    const todayStr = new Date().toISOString().split('T')[0];
    const apiKey = env.API_KEY;
    const headers = {
        'x-rapidapi-host': 'v3.football.api-sports.io',
        'x-rapidapi-key': apiKey
    };

    try {
        const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${todayStr}`, { headers });
        if (!response.ok) return [];
        const data = await response.json();
        return data.response || [];
    } catch (e) {
        console.error('Error fetching today matches:', e);
        return [];
    }
};

const saveMatchesToDb = async (env, matchesData, tableName = 'matches') => {
    if (!matchesData || matchesData.length === 0) return;

    // We'll process in batches or individually. SQLite supports ON CONFLICT.
    const queries = matchesData.map(f => {
        const home = f.teams?.home?.name || f.home;
        const away = f.teams?.away?.name || f.away;
        const time = f.fixture?.date || f.date;
        const league = f.league?.name || f.league;
        const score = f.goals ? `${f.goals.home ?? ''} - ${f.goals.away ?? ''}` : f.score;
        const status = f.fixture?.status?.short || f.status;
        const homeLogo = f.teams?.home?.logo || f.home_logo;
        const awayLogo = f.teams?.away?.logo || f.away_logo;

        return env.DB.prepare(`
            INSERT INTO ${tableName} (home_team, away_team, match_time, league, score, status, home_logo, away_logo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(home_team, away_team, match_time) DO UPDATE SET
                score = excluded.score,
                status = excluded.status,
                league = excluded.league,
                home_logo = excluded.home_logo,
                away_logo = excluded.away_logo
        `).bind(home, away, time, league, score, status, homeLogo, awayLogo);
    });

    try {
        await env.DB.batch(queries);
        console.log(`Successfully synced ${queries.length} matches to ${tableName}.`);
    } catch (e) {
        console.error(`Error saving matches to ${tableName}:`, e);
    }
};

const syncJuheMatches = async (env) => {
    const juheKey = env.JUHE_API_KEY;
    const leagues = ['yingchao', 'xijia', 'dejia', 'yijia', 'fajia', 'zhongchao'];

    for (const type of leagues) {
        try {
            console.log(`Syncing Juhe league: ${type}`);
            const response = await fetch(`http://apis.juhe.cn/fapig/football/query?key=${juheKey}&type=${type}`);
            const data = await response.json();

            if (data.error_code === 0 && data.result && data.result.matchs) {
                const matches = [];
                data.result.matchs.forEach(day => {
                    day.list.forEach(m => {
                        matches.push({
                            home: m.team1,
                            away: m.team2,
                            home_logo: m.team1_logo,
                            away_logo: m.team2_logo,
                            league: data.result.title,
                            date: `${day.date}T${m.time_start}:00Z`,
                            score: `${m.team1_score} - ${m.team2_score}`,
                            status: m.status_text
                        });
                    });
                });
                await saveMatchesToDb(env, matches, 'juhe_matches');
            }
        } catch (e) {
            console.error(`Error syncing Juhe league ${type}:`, e);
        }
    }
};

export default {
    // Cron Handler
    async scheduled(event, env, ctx) {
        console.log('Cron job started: Syncing matches...');
        // Sync API-Football
        const matchesData = await fetchTodayMatches(env);
        await saveMatchesToDb(env, matchesData);
        // Sync Juhe
        await syncJuheMatches(env);
        console.log('Cron job completed.');
    },

    // HTTP Handler
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // API Endpoint
        if (url.pathname === '/api/search') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const query = url.searchParams.get('q')?.toLowerCase() || '';

            if (query && query !== 'today') {
                // Search Mode (Always live for now, or could check DB)
                const apiKey = env.API_KEY;
                const headers = {
                    'x-rapidapi-host': 'v3.football.api-sports.io',
                    'x-rapidapi-key': apiKey
                };

                const fetchFromApi = async (endpoint) => {
                    try {
                        const response = await fetch(`https://v3.football.api-sports.io${endpoint}`, { headers });
                        if (!response.ok) return [];
                        const data = await response.json();
                        return data.response || [];
                    } catch (e) {
                        return [];
                    }
                };

                const [leaguesData, playersData, teamsData] = await Promise.all([
                    fetchFromApi(`/leagues?search=${query}`),
                    fetchFromApi(`/players?search=${query}&season=2024`),
                    fetchFromApi(`/teams?search=${query}`)
                ]);

                const leagues = leaguesData.map(l => ({
                    name: l.league.name,
                    country: l.country.name,
                    logo: l.league.logo
                }));

                const players = playersData.map(p => ({
                    name: p.player.name,
                    team: p.statistics[0]?.team?.name || 'Unknown',
                    photo: p.player.photo
                }));

                let matches = [];
                if (teamsData.length > 0) {
                    const teamId = teamsData[0].team.id;
                    const fixturesData = await fetchFromApi(`/fixtures?team=${teamId}&last=3`);
                    matches = fixturesData.map(f => ({
                        home: f.teams.home.name,
                        away: f.teams.away.name,
                        date: f.fixture.date,
                        score: `${f.goals.home ?? ''} - ${f.goals.away ?? ''}`,
                        status: f.fixture.status.short
                    }));
                }

                return new Response(JSON.stringify({ leagues, players, matches }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } else {
                // Today's Matches Mode - Fetch from DB
                try {
                    const { results } = await env.DB.prepare("SELECT * FROM matches ORDER BY match_time ASC LIMIT 30").all();

                    // If DB is empty (e.g. first run), try to trigger a sync or show nothing
                    if (results.length === 0) {
                        // Optional: trigger a live fetch once
                        const liveMatches = await fetchTodayMatches(env);
                        await saveMatchesToDb(env, liveMatches);
                        const { results: retryResults } = await env.DB.prepare("SELECT * FROM matches ORDER BY match_time ASC LIMIT 30").all();

                        return new Response(JSON.stringify({ leagues: [], players: [], matches: retryResults }), {
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        });
                    }

                    return new Response(JSON.stringify({
                        leagues: [], players: [], matches: results.map(r => ({
                            home: r.home_team,
                            away: r.away_team,
                            league: r.league,
                            date: r.match_time,
                            score: r.score,
                            status: r.status
                        }))
                    }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                } catch (e) {
                    console.error('DB read error:', e);
                    return new Response(JSON.stringify({ leagues: [], players: [], matches: [] }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }
            }
        }



        if (url.pathname === '/api/juhe/search') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const query = url.searchParams.get('q')?.toLowerCase() || 'yingchao';
            const startDate = url.searchParams.get('start'); // e.g., 2026-01-15
            const endDate = url.searchParams.get('end');     // e.g., 2026-01-20

            // Mapping logic for Juhe leagues (query -> type)
            const leagueMapping = {
                'premier league': 'yingchao',
                'la liga': 'xijia',
                'bundesliga': 'dejia',
                'serie a': 'yijia',
                'ligue 1': 'fajia',
                'csl': 'zhongchao',
                'scottish': 'jiangsu',
                'yingchao': 'yingchao',
                'xijia': 'xijia',
                'dejia': 'dejia',
                'yijia': 'yijia',
                'fajia': 'fajia',
                'zhongchao': 'zhongchao'
            };

            // Mapping Juhe type to the title string returned by API (to filter DB)
            const typeToTitle = {
                'yingchao': '英格兰超级联赛',
                'xijia': '西班牙甲级联赛',
                'dejia': '德国甲级联赛',
                'yijia': '意大利甲级联赛',
                'fajia': '法国甲级联赛',
                'zhongchao': '中国足球超级联赛',
                'jiangsu': '苏格兰超级联赛'
            };

            const type = leagueMapping[query] || query;
            const title = typeToTitle[type] || query;

            try {
                let sql = "SELECT * FROM juhe_matches WHERE league LIKE ? ";
                const params = [`%${title}%`];

                if (startDate) {
                    sql += " AND match_time >= ? ";
                    params.push(startDate);
                }
                if (endDate) {
                    // To include the whole end day, we could use < date + 1 day, or just >= and <=
                    // But since match_time is ISO string, we'll do >= start and <= end + 'T23:59:59Z'
                    sql += " AND match_time <= ? ";
                    params.push(endDate + "T23:59:59Z");
                }

                sql += " ORDER BY match_time ASC LIMIT 100";

                let { results } = await env.DB.prepare(sql).bind(...params).all();

                // If DB is empty for this league, try a live sync once
                if (results.length === 0) {
                    console.log(`DB empty for ${title}, triggering live sync...`);
                    const juheKey = env.JUHE_API_KEY;
                    const response = await fetch(`http://apis.juhe.cn/fapig/football/query?key=${juheKey}&type=${type}`);
                    const data = await response.json();

                    if (data.error_code === 0 && data.result && data.result.matchs) {
                        const syncMatches = [];
                        data.result.matchs.forEach(day => {
                            day.list.forEach(m => {
                                syncMatches.push({
                                    home: m.team1,
                                    away: m.team2,
                                    home_logo: m.team1_logo,
                                    away_logo: m.team2_logo,
                                    league: data.result.title,
                                    date: `${day.date}T${m.time_start}:00Z`,
                                    score: `${m.team1_score} - ${m.team2_score}`,
                                    status: m.status_text
                                });
                            });
                        });
                        await saveMatchesToDb(env, syncMatches, 'juhe_matches');
                        // Re-query after sync
                        const { results: retryResults } = await env.DB.prepare(sql).bind(...params).all();
                        results = retryResults;
                    }
                }

                return new Response(JSON.stringify({
                    leagues: [],
                    players: [],
                    matches: results.map(r => ({
                        home: r.home_team,
                        away: r.away_team,
                        home_logo: r.home_logo,
                        away_logo: r.away_logo,
                        league: r.league,
                        date: r.match_time,
                        score: r.score,
                        status: r.status
                    }))
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('DB query error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
};
