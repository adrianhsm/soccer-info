const styleRepaintMap = {
    '河北蔚县剪纸': 'hebeiweixianjianzhi.jpg',
    '天津杨柳青年画': 'tianjinyangliuqingnianhua.jpg',
    '四川绵竹年画': 'sichuanmianzhunianhua.jpg',
    '陕西皮影': 'shanxipiying',
    '山东杨家埠年画': 'shandongyangjiabunianhua.jpg'
};

/**
 * Helper to fetch R2 object and return as Data URI (Base64)
 */
async function getR2ObjectAsBase64(bucket, key) {
    if (!bucket) return null;
    try {
        const object = await bucket.get(key);
        if (!object) return null;
        const buffer = await object.arrayBuffer();

        // Efficient way to convert arrayBuffer to base64 in Workers
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        const contentType = object.httpMetadata?.contentType || 'image/jpeg';
        return `data:${contentType};base64,${base64}`;
    } catch (e) {
        console.error(`Error fetching from R2 (${key}):`, e);
        return null;
    }
}

const dialectVoiceMap = {
    '上海话': { female: 'Jada' },
    '北京话': { male: 'Dylan' },
    '南京话': { male: 'Li' },
    '陕西话': { male: 'Marcus' },
    '闽南语': { male: 'Roy' },
    '天津话': { male: 'Peter' },
    '四川话': { male: 'Eric', female: 'Sunny' },
    '粤语': { male: 'Rocky', female: 'Kiki' }
};

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

    const queries = [];
    matchesData.forEach(f => {
        const home = f.teams?.home?.name || f.home;
        const away = f.teams?.away?.name || f.away;
        const time = f.fixture?.date || f.date;
        const league = f.league?.name || f.league;
        const score = f.goals ? `${f.goals.home ?? ''} - ${f.goals.away ?? ''}` : f.score;
        const status = f.fixture?.status?.short || f.status;
        const homeLogo = f.teams?.home?.logo || f.home_logo;
        const awayLogo = f.teams?.away?.logo || f.away_logo;

        // 1. Update existing record if found within 24 hours (86400 seconds)
        queries.push(
            env.DB.prepare(`
                UPDATE ${tableName}
                SET match_time = ?, score = ?, status = ?, league = ?, home_logo = ?, away_logo = ?
                WHERE id = (
                    SELECT id FROM ${tableName}
                    WHERE home_team = ? AND away_team = ? 
                      AND abs(strftime('%s', match_time) - strftime('%s', ?)) <= 86400
                    LIMIT 1
                )
            `).bind(time, score, status, league, homeLogo, awayLogo, home, away, time)
        );

        // 2. Insert if not found, with standard ON CONFLICT fallback for safety
        queries.push(
            env.DB.prepare(`
                INSERT INTO ${tableName} (home_team, away_team, match_time, league, score, status, home_logo, away_logo)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?
                WHERE NOT EXISTS (
                    SELECT 1 FROM ${tableName}
                    WHERE home_team = ? AND away_team = ? 
                      AND abs(strftime('%s', match_time) - strftime('%s', ?)) <= 86400
                )
                ON CONFLICT(home_team, away_team, match_time) DO UPDATE SET
                    score = excluded.score,
                    status = excluded.status,
                    league = excluded.league,
                    home_logo = excluded.home_logo,
                    away_logo = excluded.away_logo
            `).bind(home, away, time, league, score, status, homeLogo, awayLogo, home, away, time)
        );
    });

    try {
        await env.DB.batch(queries);
        console.log(`Successfully synced ${matchesData.length} matches to ${tableName}.`);
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
                // Auto-update non-finished games started more than 2 hours ago
                // Note: DB stores match_time as Beijing Time (UTC+8) despite the 'Z' suffix
                // So we need to generate Beijing Time - 2 hours in ISO format
                const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000); // Convert to Beijing Time
                const twoHoursAgo = new Date(beijingTime.getTime() - 2 * 60 * 60 * 1000).toISOString();
                await env.DB.prepare(`
                    UPDATE juhe_matches 
                    SET status = '完赛' 
                    WHERE status != '完赛' AND match_time <= ?
                `).bind(twoHoursAgo).run();

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

                // Calculate rightTotals for all predictions of this user
                const { results: allPredictions } = await env.DB.prepare(`
                    SELECT p.prediction, j.score
                    FROM predictions p
                    JOIN juhe_matches j ON p.home_team = j.home_team 
                        AND p.away_team = j.away_team 
                        AND p.match_time = j.match_time
                    WHERE p.user_id = ? AND j.score IS NOT NULL AND j.score != ''
                `).bind(user_id).all();

                const rightTotals = allPredictions.reduce((acc, p) => {
                    if (p.score && p.score.includes('-')) {
                        const [h, a] = p.score.split('-').map(s => parseInt(s.trim()));
                        if (!isNaN(h) && !isNaN(a)) {
                            let actualOutcome = "";
                            if (h > a) actualOutcome = "主胜";
                            else if (h < a) actualOutcome = "客胜";
                            else actualOutcome = "平局";
                            if (p.prediction === actualOutcome) return acc + 1;
                        }
                    }
                    return acc;
                }, 0);

                // Get history ordered by match_time ASC, joining with juhe_matches for actual results
                const { results } = await env.DB.prepare(`
                    SELECT p.*, j.score as actual_score, j.status as match_status
                    FROM predictions p
                    LEFT JOIN juhe_matches j ON p.home_team = j.home_team 
                        AND p.away_team = j.away_team 
                        AND p.match_time = j.match_time
                    WHERE p.user_id = ? 
                    ORDER BY p.match_time ASC 
                    LIMIT ? OFFSET ?
                `).bind(user_id, pageSize, offset).all();

                return new Response(JSON.stringify({
                    metadata: {
                        total,
                        rightTotals,
                        page,
                        pageSize,
                        totalPages: Math.ceil(total / pageSize)
                    },
                    history: results.map(r => {
                        const possible_scores = JSON.parse(r.possible_scores || '[]');
                        let resultRight = null;
                        let scoreRight = null;
                        let homeScore = null;
                        let awayScore = null;

                        if (r.actual_score && r.actual_score.includes('-')) {
                            const [h, a] = r.actual_score.split('-').map(s => parseInt(s.trim()));
                            homeScore = h;
                            awayScore = a;

                            if (!isNaN(homeScore) && !isNaN(awayScore)) {
                                // Calculate actual outcome
                                let actualOutcome = "";
                                if (homeScore > awayScore) actualOutcome = "主胜";
                                else if (homeScore < awayScore) actualOutcome = "客胜";
                                else actualOutcome = "平局";

                                // Check resultRight
                                // prediction can be "主胜", "客胜", "平局"
                                resultRight = (r.prediction === actualOutcome);

                                // Check scoreRight
                                // actual score in "H-A" format
                                const normalizedActualScore = `${homeScore}-${awayScore}`;
                                scoreRight = possible_scores.includes(normalizedActualScore);
                            }
                        }

                        return {
                            ...r,
                            possible_scores,
                            resultRight,
                            scoreRight,
                            actualHomeScore: homeScore,
                            actualAwayScore: awayScore
                        };
                    })
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

        if (url.pathname === '' && request.method === 'POST') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                const matches = await request.json();
                if (!Array.isArray(matches)) {
                    return new Response(JSON.stringify({ error: 'Body must be an array of matches' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                // Prepare batch queries for each match
                const queries = matches.map(m => {
                    return env.DB.prepare(`
                        SELECT * FROM predictions 
                        WHERE home_team = ? AND away_team = ? AND match_time = ?
                        ORDER BY created_at DESC
                    `).bind(m.homeTeam, m.awayTeam, m.matchTime || '');
                });

                const batchResults = await env.DB.batch(queries);

                const response = matches.map((m, index) => {
                    const results = batchResults[index].results || [];
                    return {
                        homeTeam: m.homeTeam,
                        awayTeam: m.awayTeam,
                        matchTime: m.matchTime,
                        predictions: results.map(r => ({
                            ...r,
                            possible_scores: JSON.parse(r.possible_scores || '[]')
                        }))
                    };
                });

                return new Response(JSON.stringify(response), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Batch PredictInfo Error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/text' && request.method === 'POST') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            let body = {};
            try {
                body = await request.json();
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const { prompt, messages } = body;

            if (!prompt && !messages) {
                return new Response(JSON.stringify({ error: 'Missing required parameter: prompt or messages' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const inputMessages = messages || [{ role: 'user', content: prompt }];

            try {
                const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'qwen-flash',
                        messages: inputMessages
                    })
                });

                if (!response.ok) {
                    const error = await response.text();
                    return new Response(JSON.stringify({ error: 'Qwen API Error', details: error }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const data = await response.json();
                const content = data.choices[0].message.content;

                return new Response(JSON.stringify({
                    text: content,
                    usage: data.usage,
                    model: data.model
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });

            } catch (e) {
                return new Response(JSON.stringify({ error: 'Internal Server Error', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/img' && request.method === 'POST') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            let body = {};
            try {
                body = await request.json();
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const { prompt } = body;
            if (!prompt) {
                return new Response(JSON.stringify({ error: 'Missing required parameter: prompt' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                // Call Qwen-Image-Plus (Multimodal API)
                // This model supports text-to-image and is synchronous in the multimodal-generation endpoint
                const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'qwen-image-plus-2026-01-09',
                        input: {
                            messages: [
                                {
                                    role: 'user',
                                    content: [
                                        { text: prompt }
                                    ]
                                }
                            ]
                        },
                        parameters: {
                            size: '1024*1024'
                        }
                    })
                });

                if (!response.ok) {
                    const error = await response.text();
                    return new Response(JSON.stringify({ error: 'Generation Failed', details: error }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const data = await response.json();

                // Extract image URL from multimodal response structure
                let imageUrl = null;
                if (data.output && data.output.choices && data.output.choices[0].message.content) {
                    const content = data.output.choices[0].message.content;
                    const imageItem = content.find(item => item.image);
                    if (imageItem) {
                        imageUrl = imageItem.image;
                    }
                }

                if (!imageUrl) {
                    return new Response(JSON.stringify({ error: 'No image URL found in response', raw: data }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                return new Response(JSON.stringify({
                    url: imageUrl,
                    model: 'qwen-image-plus-2026-01-09',
                    usage: data.usage
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });

            } catch (e) {
                return new Response(JSON.stringify({ error: 'Internal Server Error', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/transform' && request.method === 'POST') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            let body = {};
            try {
                body = await request.json();
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const { image_url, style, style_ref_url, style_index } = body;

            if (!image_url) {
                return new Response(JSON.stringify({ error: 'Missing required parameter: image_url' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            let finalStyleIndex = -1;
            let finalStyleRefUrl = style_ref_url;

            if (typeof style_index === 'number') {
                finalStyleIndex = style_index;
            } else if (style && styleRepaintMap[style] !== undefined) {
                // Fetch from R2 and use as Base64 ref URL
                const r2Key = styleRepaintMap[style];
                const base64 = await getR2ObjectAsBase64(env.FESTIVAL, r2Key);
                if (base64) {
                    finalStyleRefUrl = base64;
                    finalStyleIndex = -1;
                } else {
                    // Fallback if R2 fetch fails
                    finalStyleIndex = 2; // 二次元
                }
            } else if (!style_ref_url) {
                // Default fallback
                finalStyleIndex = 2;
            }

            try {
                // Step 1: Submit Task
                const submitResponse = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
                        'Content-Type': 'application/json',
                        'X-DashScope-Async': 'enable'
                    },
                    body: JSON.stringify({
                        model: 'wanx-style-repaint-v1',
                        input: {
                            image_url: image_url,
                            style_index: finalStyleIndex,
                            style_ref_url: finalStyleIndex === -1 ? finalStyleRefUrl : undefined
                        }
                    })
                });

                if (!submitResponse.ok) {
                    const error = await submitResponse.text();
                    return new Response(JSON.stringify({ error: 'Task Submission Failed', details: error }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const submitData = await submitResponse.json();
                const taskId = submitData.output.task_id;

                // Step 2: Polling Loop (Async)
                let attempts = 0;
                const maxAttempts = 15; // ~30 seconds max
                while (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const checkResponse = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
                        headers: { 'Authorization': `Bearer ${env.QWEN_API_KEY}` }
                    });
                    const checkData = await checkResponse.json();
                    const status = checkData.output.task_status;

                    if (status === 'SUCCEEDED') {
                        return new Response(JSON.stringify({
                            url: checkData.output.results[0].url,
                            taskId,
                            status,
                            model: 'wanx-style-repaint-v1'
                        }), {
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        });
                    } else if (status === 'FAILED') {
                        return new Response(JSON.stringify({ error: 'Transformation Failed', details: checkData }), {
                            status: 502,
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        });
                    }
                    attempts++;
                }

                return new Response(JSON.stringify({
                    error: 'Processing Timeout',
                    taskId,
                    message: 'Task is still processing. Please check status later using task ID.'
                }), {
                    status: 202,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });

            } catch (e) {
                return new Response(JSON.stringify({ error: 'Internal Server Error', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/cheer' && request.method === 'POST') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            let body = {};
            try {
                body = await request.json();
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const { sex, dialect, target } = body;

            // Validate required parameters
            if (!sex || !dialect || !target) {
                return new Response(JSON.stringify({
                    error: 'Missing required parameters: sex, dialect, and target are required'
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            // Validate sex parameter
            if (!['male', 'female'].includes(sex.toLowerCase())) {
                return new Response(JSON.stringify({
                    error: 'Invalid sex parameter. Must be "male" or "female"'
                }), {
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

            try {
                // Step 1: Generate blessing text using Qwen3
                const textPrompt = `请用${dialect}生成一段新春祝福语，对象是${target}，要求：
1. 语言风格符合${dialect}的特点
2. 内容温馨、真诚、富有节日气氛
3. 长度控制在50-100字之间
4. 只返回祝福语本身，不要有其他说明

请直接生成祝福语：`;

                const textResponse = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'qwen-max',
                        messages: [
                            { role: 'system', content: '你是一个专业的祝福语生成助手，擅长用各种方言生成温馨的祝福语。' },
                            { role: 'user', content: textPrompt }
                        ]
                    })
                });

                if (!textResponse.ok) {
                    const error = await textResponse.text();
                    console.error('Qwen Text API Error:', error);
                    return new Response(JSON.stringify({ error: 'Failed to generate blessing text' }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const textData = await textResponse.json();
                const blessingText = textData.choices[0].message.content.trim();

                // Step 2: Generate audio using Qwen3-TTS-Flash
                // Select specific voice based on dialect and sex
                let voice = sex.toLowerCase() === 'male' ? 'Ethan' : 'Cherry';
                const lowerDialect = dialect.trim();

                if (dialectVoiceMap[lowerDialect]) {
                    const sexLower = sex.toLowerCase();
                    if (dialectVoiceMap[lowerDialect][sexLower]) {
                        voice = dialectVoiceMap[lowerDialect][sexLower];
                    } else {
                        // If specific sex voice not found for dialect, use the available one from map or stick to default
                        const availableVoices = Object.values(dialectVoiceMap[lowerDialect]);
                        if (availableVoices.length > 0) {
                            voice = availableVoices[0];
                        }
                    }
                }

                const ttsResponse = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'qwen3-tts-flash',
                        input: {
                            text: blessingText,
                            voice: voice
                        }
                    })
                });

                if (!ttsResponse.ok) {
                    const error = await ttsResponse.text();
                    console.error('Qwen TTS API Error:', error);
                    return new Response(JSON.stringify({
                        error: 'Failed to generate audio',
                        errorDetails: error,
                        statusCode: ttsResponse.status,
                        text: blessingText
                    }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const ttsResult = await ttsResponse.json();
                let audioUrl = null;
                let audioData = null;

                if (ttsResult.output && ttsResult.output.audio && ttsResult.output.audio.url) {
                    audioUrl = ttsResult.output.audio.url;
                } else {
                    console.error('Unexpected TTS response format:', ttsResult);
                }

                return new Response(JSON.stringify({
                    text: blessingText,
                    audioUrl: audioUrl,
                    audioData: audioData,
                    parameters: {
                        sex,
                        dialect,
                        target,
                        voice,
                        tts_model: 'qwen3-tts-flash'
                    }
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });

            } catch (e) {
                console.error('Cheer API Error:', e);
                return new Response(JSON.stringify({
                    error: 'Internal Server Error',
                    details: e.message
                }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
};
