

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

            const query = url.searchParams.get('q')?.toLowerCase() || '';
            const leagueParam = url.searchParams.get('league')?.toLowerCase() || '';
            const startDate = url.searchParams.get('start');
            const endDate = url.searchParams.get('end');
            const page = parseInt(url.searchParams.get('page') || '1');
            const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
            const offset = (page - 1) * pageSize;

            // Mapping logic for Juhe leagues
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

            const typeToTitle = {
                'yingchao': '英格兰超级联赛',
                'xijia': '西班牙甲级联赛',
                'dejia': '德国甲级联赛',
                'yijia': '意大利甲级联赛',
                'fajia': '法国甲级联赛',
                'zhongchao': '中国足球超级联赛',
                'jiangsu': '苏格兰超级联赛'
            };

            const targetLeague = leagueParam || query || 'yingchao';
            const type = leagueMapping[targetLeague] || targetLeague;
            const title = typeToTitle[type] || targetLeague;

            try {
                let whereClause = "WHERE league LIKE ? ";
                const params = [`%${title}%`];

                if (startDate) {
                    whereClause += " AND match_time >= ? ";
                    params.push(startDate);
                }
                if (endDate) {
                    whereClause += " AND match_time <= ? ";
                    params.push(endDate + "T23:59:59Z");
                }

                // Get total count for pagination metadata
                const countSql = `SELECT COUNT(*) as total FROM juhe_matches ${whereClause}`;
                const { results: countResults } = await env.DB.prepare(countSql).bind(...params).all();
                let total = countResults[0].total;

                let sql = `SELECT * FROM juhe_matches ${whereClause} ORDER BY match_time ASC LIMIT ? OFFSET ?`;
                const queryParams = [...params, pageSize, offset];

                let { results } = await env.DB.prepare(sql).bind(...queryParams).all();

                // If DB is empty for this league, try a live sync once
                if (results.length === 0 && page === 1) {
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
                        const { results: retryResults } = await env.DB.prepare(sql).bind(...queryParams).all();
                        results = retryResults;

                        // Re-fetch total if needed, but for simplicity we assume sync succeeded
                        const { results: retryCountResults } = await env.DB.prepare(countSql).bind(...params).all();
                        total = retryCountResults[0].total;
                    }
                }

                return new Response(JSON.stringify({
                    metadata: {
                        total,
                        page,
                        pageSize,
                        totalPages: Math.ceil(total / pageSize)
                    },
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

        if (url.pathname === '/api/predict') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            let body = {};
            if (request.method === 'POST') {
                try {
                    body = await request.json();
                } catch (e) {
                    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }
            } else {
                body = {
                    user_id: url.searchParams.get('user_id'),
                    homeTeam: url.searchParams.get('homeTeam'),
                    awayTeam: url.searchParams.get('awayTeam'),
                    matchTime: url.searchParams.get('matchTime'),
                    extraInfo: url.searchParams.get('extraInfo')
                };
            }

            const { user_id, homeTeam, awayTeam, matchTime, extraInfo } = body;

            if (!user_id || !homeTeam || !awayTeam) {
                return new Response(JSON.stringify({ error: 'user_id, homeTeam and awayTeam are required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            if (!env.QWEN_API_KEY) {
                return new Response(JSON.stringify({ error: 'QWEN_API_KEY not configured' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const prompt = `
你是一个专业的足球数据分析专家。请根据以下比赛信息进行详细活跃的分析，并提供胜负预测和可能的3个比分。

**重要指令**：
1. 请务必检索并使用截至比赛日期前最新的球队信息（包括但不限于球员转会、伤病、教练更迭、近期战绩等）。
2. 请核实当前的球员名单和主教练情况，严禁引用已经离队或卸任的人员作为当前分析依据（例如：某球员已转会至他队，分析中不得说其仍在原队效力）。
3. 分析应体现专业性，若对某些最新动态不确定，请优先检索实时数据或说明基于当前已知最前线的信息。

比赛信息：
- 主队：${homeTeam}
- 客队：${awayTeam}
- 比赛时间：${matchTime || '未提供'}
- 额外信息：${extraInfo || '无'}
- 当前系统参考时间：${new Date().toISOString().split('T')[0]}

请提供：
1. **详细分析**：包括两队近况、伤病、历史战绩等方面的综合评估。
2. **胜负预测**：给出明确的胜、平、负倾向及理由。
3. **可能的3个比分**：按可能性从高到低排列。

请以JSON格式返回结果，结构如下：
{
  "analysis": "这里是详细分析内容...",
  "prediction": "主胜/平局/客胜",
  "prediction_reason": "理由...",
  "possible_scores": ["2-1", "1-1", "2-0"]
}
`;

            try {
                const aiResponse = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'qwen3-max',
                        messages: [
                            { role: 'system', content: 'You are a helpful assistant that provides professional soccer match analysis in JSON format.' },
                            { role: 'user', content: prompt }
                        ],
                        response_format: { type: 'json_object' }
                    })
                });

                if (!aiResponse.ok) {
                    const error = await aiResponse.text();
                    console.error('Qwen API Error:', error);
                    return new Response(JSON.stringify({ error: 'Failed to fetch prediction from Qwen API' }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const aiData = await aiResponse.json();
                const content = aiData.choices[0].message.content;
                const result = JSON.parse(content);

                // Store in DB
                try {
                    await env.DB.prepare(`
                        INSERT INTO predictions (user_id, home_team, away_team, match_time, extra_info, analysis, prediction, prediction_reason, possible_scores)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                        user_id,
                        homeTeam,
                        awayTeam,
                        matchTime || '',
                        extraInfo || '',
                        result.analysis,
                        result.prediction,
                        result.prediction_reason,
                        JSON.stringify(result.possible_scores)
                    ).run();
                } catch (dbError) {
                    console.error('Failed to store prediction:', dbError);
                    // We still return the result even if storage fails
                }

                return new Response(content, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Prediction Error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/predict/history') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const user_id = url.searchParams.get('user_id');
            const page = parseInt(url.searchParams.get('page') || '1');
            const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
            const offset = (page - 1) * pageSize;

            if (!user_id) {
                return new Response(JSON.stringify({ error: 'user_id is required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                // Get total count
                const { results: countResults } = await env.DB.prepare("SELECT COUNT(*) as total FROM predictions WHERE user_id = ?").bind(user_id).all();
                const total = countResults[0].total;

                // Get history ordered by match_time ASC
                const { results } = await env.DB.prepare(`
                    SELECT * FROM predictions 
                    WHERE user_id = ? 
                    ORDER BY match_time ASC 
                    LIMIT ? OFFSET ?
                `).bind(user_id, pageSize, offset).all();

                return new Response(JSON.stringify({
                    metadata: {
                        total,
                        page,
                        pageSize,
                        totalPages: Math.ceil(total / pageSize)
                    },
                    history: results.map(r => ({
                        ...r,
                        possible_scores: JSON.parse(r.possible_scores || '[]')
                    }))
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('History Query Error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
};
