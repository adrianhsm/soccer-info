// ===== MiniMax M3 Multi-Step Agent（原生 fetch，OpenAI chat completions 兼容）=====
// 说明：Vercel AI SDK 5+ 默认走 OpenAI Responses API，MiniMax 不支持。
//       这里用原生 fetch 直接调 /v1/chat/completions，自己实现 multi-step tool_use loop。

// 工具：fetch_500（500.com 列表页 HTML，GBK 解码）
const toolFetch500 = async (env) => {
    const paths = ['/jczq/', '/jczq/dg.shtml', '/jczq/issue.php'];
    const uas = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    ];
    for (const path of paths) {
        for (const ua of uas) {
            try {
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), 10_000);
                const res = await fetch(`https://trade.500.com${path}`, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': ua,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                        'Referer': 'https://www.500.com/'
                    }
                });
                clearTimeout(tid);
                if (res.ok) {
                    const buf = await res.arrayBuffer();
                    // 关键：500.com HTML 是 GBK/GB2312 编码，必须手动解码
                    let text;
                    try {
                        text = new TextDecoder('gbk', { fatal: false }).decode(buf);
                    } catch (e) {
                        text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
                    }
                    if (text.length > 5000) {
                        // 提取比赛行：500.com 用 class="bet_table" 包含每场比赛
                        // 简化：取所有含"vs"或"VS"的中文行 + 前后的 match_id/league
                        const lines = text.split('\n');
                        const matchLines = [];
                        for (let i = 0; i < lines.length; i++) {
                            if (/周[一二三四五六日]\d{3}/.test(lines[i])) {
                                // match_id 行
                                matchLines.push(lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 5)).join(' '));
                            }
                        }
                        // 同时也截取关键 HTML 段（table 区域）
                        const tableMatch = text.match(/<table[^>]*class="[^"]*(?:bet_list|bet_table|matches)[^"]*"[\s\S]{0,8000}?<\/table>/gi);
                        const tableSnippet = tableMatch ? tableMatch.join('\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 4000) : '';
                        return {
                            ok: true,
                            source: `500.com${path}`,
                            totalLength: text.length,
                            matchLines: matchLines.slice(0, 20).join('\n'),
                            tableSnippet: tableSnippet || 'no table found',
                            sample: text.substring(0, 2000)
                        };
                    }
                }
            } catch (e) { /* try next */ }
        }
    }
    return { ok: false, error: '500.com 全部 path/UA 失败' };
};

// 工具：search_web（用 M3/Qwen 联网搜索）
const toolSearchWeb = async (env, query) => {
    try {
        const content = await aiWebSearch(env, query);
        return { ok: true, source: 'ai-search', contentLength: content.length, content: content.substring(0, 6000) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
};

// M3 工具定义（OpenAI function calling 格式）
const M3_TOOLS_SCHEMA = [
    {
        type: 'function',
        function: {
            name: 'fetch_500',
            description: '直接拉取 500.com 竞彩足球列表页 HTML（最权威数据源，境外 IP 会被反爬）',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: '用 M3/Qwen 联网搜索查询竞彩比赛',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '搜索 query' } },
                required: ['query']
            }
        }
    }
];

// M3 chat completions API 调用（原生 fetch）
const m3ChatCompletion = async (env, messages, tools = null) => {
    const baseURL = (env.MINIMAX_API_HOST || 'https://api.minimaxi.com') + '/v1';
    const body = {
        model: 'MiniMax-M3',
        messages,
        max_tokens: 4000,
        temperature: 0.1
    };
    if (tools) body.tools = tools;
    const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.MINIMAX_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`M3 chat ${res.status}: ${err.substring(0, 300)}`);
    }
    return await res.json();
};

// M3 多步 agent：自己实现 OpenAI 风格 tool_use 循环
const syncJcMatchesViaM3Agent = async (env) => {
    if (!env.MINIMAX_API_KEY) {
        return { error: 'MINIMAX_API_KEY not configured' };
    }
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
    console.log(`[M3 Agent] start, target: ${today} ~ ${tomorrow}`);

    const messages = [
        {
            role: 'system',
            content: `你是中国体育彩票竞彩足球数据查询专家。任务：使用工具获取今天(${today})和明天(${tomorrow})中国体彩中心"竞彩足球"在售的全部比赛。

要求：
1. 优先使用 fetch_500 工具直接拉取 500.com 实时数据（最权威）
2. 如 500 失败，使用 search_web 工具用 M3/Qwen 联网搜索兜底
3. 每场比赛必须有：matchNum(竞彩官方编号如"周二001")、league、home、away、matchTime
4. 不要猜测 matchNum——如果工具没有返回，设为 null
5. 至少尝试 2-3 个不同 query（今天/明天/本周）
6. 最后输出 { matches: [...] } JSON 数组

注意：
- 周X 是官方前缀（周一/周二/周三/周四/周五/周六/周日），后面跟 3 位数字编号
- 主队在前客队在后
- 时间用 ISO 格式 +08:00 时区`
        },
        {
            role: 'user',
            content: `请获取 ${today} 和 ${tomorrow} 中国竞彩足球在售的所有比赛，最终输出 JSON。`
        }
    ];

    const maxSteps = 5;
    let step = 0;
    let finalText = '';
    const stepsLog = [];

    while (step < maxSteps) {
        step++;
        let resp;
        try {
            resp = await m3ChatCompletion(env, messages, M3_TOOLS_SCHEMA);
        } catch (e) {
            console.error(`[M3 Agent] step ${step} API error:`, e.message);
            return { error: `M3 chat failed: ${e.message}`, step, steps: stepsLog };
        }
        const choice = resp.choices?.[0];
        if (!choice) {
            return { error: 'M3 returned no choice', resp: JSON.stringify(resp).substring(0, 500) };
        }
        const msg = choice.message || {};
        const toolCalls = msg.tool_calls || [];
        stepsLog.push({ step, content: msg.content?.substring(0, 200), toolCalls: toolCalls.map(t => t.function?.name) });
        console.log(`[M3 Agent] step ${step}, tool_calls=${toolCalls.length}, content_len=${msg.content?.length || 0}`);

        // 累加 assistant message（OpenAI 协议要求）
        messages.push(msg);

        if (toolCalls.length === 0) {
            // 没有 tool call → final answer
            finalText = msg.content || '';
            break;
        }

        // 执行每个 tool call
        for (const tc of toolCalls) {
            const fnName = tc.function?.name;
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { args = {}; }
            let toolResult;
            try {
                if (fnName === 'fetch_500') {
                    toolResult = await toolFetch500(env);
                } else if (fnName === 'search_web') {
                    toolResult = await toolSearchWeb(env, args.query || '');
                } else {
                    toolResult = { error: `Unknown tool: ${fnName}` };
                }
            } catch (e) {
                toolResult = { error: e.message };
            }
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify(toolResult).substring(0, 8000)
            });
        }
    }
    console.log(`[M3 Agent] done, steps=${step}, finalLen=${finalText.length}`);

    // 解析 final text
    const jsonMatch = finalText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
        return {
            error: 'No JSON in final text',
            text: finalText.substring(0, 1000),
            steps: step,
            stepsLog
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
        return { error: `JSON parse error: ${e.message}`, text: finalText.substring(0, 500), steps: step, stepsLog };
    }
    const matches = (parsed.matches || []).filter(m => m && m.home && m.away);
    if (matches.length === 0) {
        return { error: 'Agent returned 0 matches', text: finalText.substring(0, 500), steps: step, stepsLog };
    }

    // 写入 D1
    let inserted = 0, sqlErrors = 0;
    for (const m of matches) {
        try {
            const odds = m.odds ? JSON.stringify(m.odds) : null;
            let matchTime = m.matchTime || null;
            if (!matchTime && m.sellEndTime) {
                matchTime = `${today}T${m.sellEndTime}:00+08:00`;
            }
            await env.DB.prepare(`
                INSERT OR IGNORE INTO lottery_jc_matches (home_team, away_team, match_time, league, score, status, odds, lottery_type, match_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                m.home, m.away, matchTime, m.league || '竞彩', '- -', '未开售',
                odds, '竞彩', m.matchNum || null
            ).run();
            inserted++;
        } catch (e) {
            sqlErrors++;
            console.error(`[M3 Agent] insert error ${m.home} vs ${m.away}:`, e.message);
        }
    }
    return { count: matches.length, inserted, errors: sqlErrors, steps: step, source: 'm3-agent-native' };
};

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
};

const generateFiroSignature = async (privateKey, timestamp, apiKey, params = null) => {
    try {
        // 签名公式: apiKey={apiKey}&timestamp={timestamp}&{排序后的参数}
        const parts = [`apiKey=${apiKey}`, `timestamp=${timestamp}`];
        if (params && typeof params === 'object') {
            for (const key of Object.keys(params).sort()) {
                const val = params[key];
                if (val !== null && val !== undefined) {
                    parts.push(`${key}=${val}`);
                }
            }
        }
        const stringToSign = parts.join('&');

        const pemLines = privateKey.match(/.{1,64}/g) || [];
        const pemKey = `-----BEGIN PRIVATE KEY-----\n${pemLines.join('\n')}\n-----END PRIVATE KEY-----`;
        const keyData = Uint8Array.from(atob(privateKey), c => c.charCodeAt(0));
        const key = await crypto.subtle.importKey(
            'pkcs8',
            keyData,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const encoder = new TextEncoder();
        const signature = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            key,
            encoder.encode(stringToSign)
        );
        return btoa(String.fromCharCode(...new Uint8Array(signature)));
    } catch (e) {
        console.error('Signature error:', e);
        return '';
    }
};

const syncFiroMatchResults = async (env) => {
    if (!env.FIRO_API_KEY || !env.FIRO_PRIVATE_KEY) {
        console.log('Firo API keys not configured, skipping match-results sync...');
        return;
    }

    const timeout = 60 * 1000;
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const dayBefore = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
    
    const formatDate = (d) => d.toISOString().split('T')[0];
    const startDate = formatDate(dayBefore);
    const endDate = formatDate(yesterday);
    
    console.log(`Syncing JC match-results from ${startDate} to ${endDate}...`);

    try {
        const timestamp = Date.now().toString();
        const params = { endDate, startDate };
        const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY, params);
        const headers = {
            'X-API-Key': env.FIRO_API_KEY,
            'X-Timestamp': timestamp,
            'X-Signature': signature
        };

        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);

        const apiUrl = `https://www.firoapi.com/firo/text/match-results?startDate=${startDate}&endDate=${endDate}`;
        const response = await fetch(apiUrl, { headers, signal: controller.signal });
        clearTimeout(tid);
        
        const data = await response.json();
        console.log(`match-results API response: code=${data.code}, message=${data.message}, results count=${data.data?.results?.length || 0}`);
        
        if (data.code === 200 && data.data?.results) {
            await updateJcMatchesWithResults(env, data.data.results);
            console.log(`Successfully updated JC matches with results`);
        }
    } catch (e) {
        console.error('Error syncing Firo match-results:', e.message);
    }
};

const updateJcMatchesWithResults = async (env, results) => {
    if (!results || results.length === 0) return;

    const queries = [];
    let skippedNotFinished = 0;
    for (const r of results) {
        // 只有比赛状态表述为"已结束"时才更新比分
        // matchResultStatus: "2" 表示比赛已结束（有最终比分）
        // poolStatus: "Payout" 表示已派奖
        const isFinished = r.matchResultStatus === '2' || r.poolStatus === 'Payout';
        if (!isFinished) {
            skippedNotFinished++;
            console.log(`Skip match ${r.matchNumStr || r.matchId} (${r.homeTeam} vs ${r.awayTeam}): matchResultStatus=${r.matchResultStatus}, poolStatus=${r.poolStatus}, 无最终比分`);
            continue;
        }

        // 没有最终比分也跳过
        if (!r.sectionsNo999 || r.sectionsNo999.trim() === '' || r.sectionsNo999 === '-:-') {
            console.log(`Skip match ${r.matchNumStr || r.matchId} (${r.homeTeam} vs ${r.awayTeam}): 比分字段为空`);
            continue;
        }

        const fullScore = r.sectionsNo999 || '';
        const halfScore = r.sectionsNo1 || '';
        const winFlag = r.winFlag || '';
        const oddsData = {
            h: r.h,
            d: r.d,
            a: r.a,
            goalLine: r.goalLine,
            winFlag: winFlag,
            halfScore: halfScore,
            oddsResults: r.oddsResults || []
        };

        const matchDate = r.matchDate;
        if (!matchDate) continue;

        const homeTeamName = r.homeTeam || r.allHomeTeam;
        const awayTeamName = r.awayTeam || r.allAwayTeam;
        if (!homeTeamName || !awayTeamName) continue;

        queries.push(
            env.DB.prepare(`
                UPDATE lottery_jc_matches
                SET score = ?,
                    status = '已开奖',
                    odds = ?,
                    win_flag = ?
                WHERE home_team = ? AND away_team = ? AND substr(match_time, 1, 10) = ?
            `).bind(fullScore, JSON.stringify(oddsData), winFlag, homeTeamName, awayTeamName, matchDate)
        );
    }

    if (skippedNotFinished > 0) {
        console.log(`Skipped ${skippedNotFinished} matches with unfinished status`);
    }
    
    if (queries.length > 0) {
        try {
            await env.DB.batch(queries);
            console.log(`Updated ${queries.length} JC matches with results`);
        } catch (e) {
            console.error('Error updating JC matches:', e.message);
        }
    }
};

const syncFiroLottery = async (env) => {
    if (!env.FIRO_API_KEY || !env.FIRO_PRIVATE_KEY) {
        console.log('Firo API keys not configured, skipping...');
        return;
    }

    const timeout = 60 * 1000;
    const timestamp = Date.now().toString();
    
    try {
        const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY);
        console.log(`Generated signature: ${signature.substring(0, 50)}...`);
        
        const headers = {
            'X-API-Key': env.FIRO_API_KEY,
            'X-Timestamp': timestamp,
            'X-Signature': signature
        };

        console.log('Syncing Firo JC (竞彩) data...');
        console.log('Request headers:', JSON.stringify(headers));
        const jcController = new AbortController();
        const jcTimeout = setTimeout(() => jcController.abort(), timeout);
        
        const jcResponse = await fetch('https://www.firoapi.com/firo/sports-lottery/list', {
            headers,
            signal: jcController.signal
        });
        clearTimeout(jcTimeout);
        
        const jcData = await jcResponse.json();
        console.log(`JC API response: code=${jcData.code}, message=${jcData.message}, data=${JSON.stringify(jcData.data)?.substring(0, 500)}`);
        
        if (jcData.code === 200 && jcData.data) {
            const jcMatchIds = await saveFiroMatchesToDb(env, jcData.data, 'lottery_jc_matches', '竞彩');
            console.log(`Synced JC matches successfully, ${jcMatchIds.length} matches to enrich`);
            if (jcMatchIds.length > 0) {
                await enrichJcMatchesWithFootballInfo(env, jcMatchIds);
            }
        }

        // JC 同步完成后，把 football_info 同步到 juhe_matches 的相同比赛
        await syncFootballInfoToJuheMatches(env);

        console.log('Syncing Firo BD (北单) data...');
        // ⚠️ 重要：BD 比赛**仅**从 Firo bd/issue-detail 获取，不使用 juhe
        // lottery_bd_matches 表只允许由 Firo 写入（见 saveFiroMatchesToDb 调用点 line 254）
        // syncJuheMatches 中没有 BD 联赛的同步路径
        const bdController = new AbortController();
        const bdTimeout = setTimeout(() => bdController.abort(), timeout);
        
        const bdResponse = await fetch('https://www.firoapi.com/firo/bd/issue-detail', {
            headers,
            signal: bdController.signal
        });
        clearTimeout(bdTimeout);
        
        const bdData = await bdResponse.json();
        console.log(`BD API response: code=${bdData.code}, data=${JSON.stringify(bdData.data)?.substring(0, 200)}`);
        
        if (bdData.code === 200 && bdData.data) {
            // 📝 记录 sync 日志到数据库（用于排查数据源问题）
            const drawNo = bdData.data.drawNo || 'unknown';
            const totalMatches = bdData.data.issues?.reduce((sum, i) => sum + (i.matches?.length || 0), 0) || 0;
            const nonFootballLeagues = ['美职篮', '美职冰'];
            const allMatches = [];
            bdData.data.issues?.forEach(issue => {
                issue.matches?.forEach(m => {
                    if (!nonFootballLeagues.includes(m.leagueName)) {
                        allMatches.push(m);
                    }
                });
            });
            try {
                await env.DB.prepare(
                    `INSERT INTO sync_logs (sync_type, draw_no, matches_count, source, success) VALUES (?, ?, ?, ?, 1)`
                ).bind('BD', drawNo, allMatches.length, 'Firo').run();
            } catch (e) {
                console.error('Failed to write sync log:', e.message);
            }
            await saveFiroMatchesToDb(env, allMatches, 'lottery_bd_matches', '北单');
            console.log(`Synced BD matches successfully, filtered ${totalMatches - allMatches.length} non-football matches, drawNo=${drawNo}`);
        } else {
            try {
                await env.DB.prepare(
                    `INSERT INTO sync_logs (sync_type, draw_no, matches_count, source, success, error_msg) VALUES (?, ?, ?, ?, 0, ?)`
                ).bind('BD', 'N/A', 0, 'Firo', bdData.message || 'unknown error').run();
            } catch (e) {
                console.error('Failed to write sync log:', e.message);
            }
        }
    } catch (e) {
        console.error('Error syncing Firo lottery:', e.message);
    }
};

const saveFiroMatchesToDb = async (env, matchesData, tableName, lotteryType) => {
    if (!matchesData || matchesData.length === 0) {
        console.log(`No ${lotteryType} matches to save`);
        return [];
    }

    const queries = [];
    const jcMatchIdsToEnrich = [];

    matchesData.forEach(m => {
        let home, away, score, status, matchTime, league, odds, homeLogo, awayLogo, matchId;

        if (lotteryType === '竞彩') {
            const matchMain = m.matchMain || m;
            matchId = matchMain.matchId || m.matchId;
            home = matchMain.homeTeamName || m.homeTeamName;
            away = matchMain.awayTeamName || m.awayTeamName;
            homeLogo = matchMain.homeTeamBadgeUrl || m.homeTeamBadgeUrl || '';
            awayLogo = matchMain.awayTeamBadgeUrl || m.awayTeamBadgeUrl || '';
            league = matchMain.leagueName || m.leagueName || '竞彩';
            const matchDate = matchMain.matchStartDate || m.matchStartDate || matchMain.matchDate;
            const matchTimeStr = matchMain.matchTime || m.matchTime || '00:00';
            matchTime = matchDate ? `${matchDate}T${matchTimeStr}:00Z` : null;
            const homeScore = matchMain.homeScore || m.homeScore;
            const awayScore = matchMain.awayScore || m.awayScore;
            score = homeScore !== undefined && awayScore !== undefined ? `${homeScore} - ${awayScore}` : '- -';
            const sellStatus = matchMain.sellStatus || m.sellStatus || matchMain.matchStatus;
            status = sellStatus === 'Selling' || sellStatus === '1' ? '销售中' :
                     sellStatus === 'Closed' || sellStatus === '2' ? '已结束' : '未知';
            odds = m.matchOddsList ? JSON.stringify(m.matchOddsList) : null;
        } else {
            matchId = m.matchId;
            home = m.hostTeamFull || m.hostTeam;
            away = m.guestTeamFull || m.guestTeam;
            league = m.leagueName || lotteryType;
            const flagUrl = getFlagUrlByLeague(league);
            homeLogo = getFlagUrl(home) || flagUrl || m.hostTeamBadgeUrl || '';
            awayLogo = getFlagUrl(away) || flagUrl || m.guestTeamBadgeUrl || '';
            matchTime = m.endTime ? new Date(new Date(m.endTime).getTime() + 5 * 60 * 1000).toISOString() : (m.matchGroupDt ? m.matchGroupDt.replace('T', 'T') + ':00Z' : null);
            score = m.fullScore ? m.fullScore.replace(',', ' - ') : '- -';
            status = m.drawed ? '已开奖' : m.matchState === 'Selling' ? '销售中' : '未开售';
            const oddsData = {};
            for (let i = 1; i <= 25; i++) {
                const spKey = `sp${i}`;
                if (m[spKey]) oddsData[spKey] = m[spKey];
            }
            odds = Object.keys(oddsData).length > 0 ? JSON.stringify(oddsData) : null;
        }

        if (!home || !away) return;

        // BD 表使用 UPSERT（按 home_team + away_team + 同一天匹配），保留原 id 和 created_at
        // lottery_bd_matches 已有 UNIQUE 索引 idx_lottery_bd_unique
        // lottery_jc_matches 没有 UNIQUE 约束，用 INSERT OR REPLACE 退化为纯 INSERT
        if (tableName === 'lottery_bd_matches') {
            queries.push(
                env.DB.prepare(`
                    INSERT INTO ${tableName}
                    (home_team, away_team, match_time, league, score, status, odds, lottery_type, home_logo, away_logo, match_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(home_team, away_team, substr(match_time, 1, 10))
                    DO UPDATE SET
                        match_time = excluded.match_time,
                        league = excluded.league,
                        score = excluded.score,
                        status = excluded.status,
                        odds = excluded.odds,
                        home_logo = excluded.home_logo,
                        away_logo = excluded.away_logo,
                        match_id = excluded.match_id
                `).bind(home, away, matchTime, league, score, status, odds, lotteryType, homeLogo || '', awayLogo || '', matchId || null)
            );
        } else {
            queries.push(
                env.DB.prepare(`
                    INSERT OR REPLACE INTO ${tableName}
                    (home_team, away_team, match_time, league, score, status, odds, lottery_type, home_logo, away_logo, match_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(home, away, matchTime, league, score, status, odds, lotteryType, homeLogo || '', awayLogo || '', matchId || null)
            );
        }

        if (lotteryType === '竞彩' && matchId) {
            jcMatchIdsToEnrich.push(matchId);
        }
    });

    try {
        await env.DB.batch(queries);
        console.log(`Successfully synced ${matchesData.length} ${lotteryType} matches to ${tableName}`);
        return jcMatchIdsToEnrich;
    } catch (e) {
        console.error(`Error saving ${lotteryType} matches:`, e);
        return [];
    }
};

const enrichJcMatchesWithFootballInfo = async (env, matchIds) => {
    if (!env.FIRO_API_KEY || !env.FIRO_PRIVATE_KEY) return;
    if (!matchIds || matchIds.length === 0) {
        console.log('No JC match IDs to enrich with football-info');
        return;
    }

    const placeholders = matchIds.map(() => '?').join(',');
    const existing = await env.DB.prepare(`
        SELECT match_id FROM lottery_jc_matches
        WHERE match_id IN (${placeholders}) AND football_info IS NOT NULL
    `).bind(...matchIds).all();

    const enrichedIds = new Set(existing.results?.map(r => r.match_id) || []);
    const idsToFetch = matchIds.filter(id => !enrichedIds.has(id));

    console.log(`JC football-info enrichment: ${idsToFetch.length} matches need fetching (already enriched: ${enrichedIds.size})`);

    if (idsToFetch.length === 0) return;

    const queries = [];
    let successCount = 0;
    let errorCount = 0;

    for (const matchId of idsToFetch) {
        try {
            // 每个 matchId 需要单独的签名
            const ts = Date.now().toString();
            const sig = await generateFiroSignature(env.FIRO_PRIVATE_KEY, ts, env.FIRO_API_KEY, { matchId });
            const headers = {
                'X-API-Key': env.FIRO_API_KEY,
                'X-Timestamp': ts,
                'X-Signature': sig
            };
            const response = await fetch(`https://www.firoapi.com/firo/sports-lottery/football-info?matchId=${matchId}`, { headers });
            const text = await response.text();

            if (response.ok) {
                const data = JSON.parse(text);
                if (data.code === 200 && data.data) {
                    queries.push(
                        env.DB.prepare(`
                            UPDATE lottery_jc_matches
                            SET football_info = ?
                            WHERE match_id = ?
                        `).bind(JSON.stringify(data.data), matchId)
                    );
                    successCount++;
                } else {
                    console.log(`football-info match ${matchId}: API code=${data.code}, msg=${data.message}`);
                    errorCount++;
                }
            } else {
                console.log(`football-info match ${matchId}: HTTP ${response.status}`);
                errorCount++;
            }
        } catch (e) {
            console.error(`Error fetching football-info for match ${matchId}:`, e.message);
            errorCount++;
        }
    }

    if (queries.length > 0) {
        try {
            await env.DB.batch(queries);
            console.log(`JC football-info enrichment: ${successCount} success, ${errorCount} failed`);
        } catch (e) {
            console.error('Error saving football-info:', e.message);
        }
    }
};

// 将 lottery_jc_matches / lottery_bd_matches 的 football_info 同步到 juhe_matches 中
// 当主客队相同时，认为是同一场比赛
const syncFootballInfoToJuheMatches = async (env) => {
    try {
        // 1. 先检查表是否有 football_info 列（容错处理 D1 副本同步延迟）
        let juheHasFootballInfo = false;
        try {
            const { results: cols } = await env.DB.prepare(`PRAGMA table_info(juhe_matches)`).all();
            juheHasFootballInfo = (cols || []).some(c => c.name === 'football_info');
        } catch (e) {
            console.log('PRAGMA failed:', e.message);
        }

        if (!juheHasFootballInfo) {
            console.log('juhe_matches has no football_info column yet, skipping sync');
            return;
        }

        // 2. 从 lottery_jc_matches 中取所有有 football_info 的记录
        const { results: jcRows } = await env.DB.prepare(`
            SELECT home_team, away_team, football_info
            FROM lottery_jc_matches
            WHERE football_info IS NOT NULL
        `).all();

        // 3. 从 lottery_bd_matches 中取所有有 football_info 的记录
        const { results: bdRows } = await env.DB.prepare(`
            SELECT home_team, away_team, football_info
            FROM lottery_bd_matches
            WHERE football_info IS NOT NULL
        `).all();

        const sourceRows = [...(jcRows || []), ...(bdRows || [])];
        if (sourceRows.length === 0) {
            console.log('No football_info in lottery tables to sync');
            return;
        }

        console.log(`Syncing football_info from ${sourceRows.length} lottery matches to juhe_matches...`);

        let updated = 0;

        for (const row of sourceRows) {
            // 按主客队匹配，更新 juhe_matches
            const result = await env.DB.prepare(`
                UPDATE juhe_matches
                SET football_info = ?
                WHERE home_team = ? AND away_team = ?
                  AND (football_info IS NULL OR football_info = '')
            `).bind(row.football_info, row.home_team, row.away_team).run();

            const changes = result.meta?.changes || result.changes || 0;
            if (changes > 0) {
                updated += changes;
            }
        }

        console.log(`Synced football_info to ${updated} juhe_matches records`);
    } catch (e) {
        console.error('Error syncing football_info to juhe_matches:', e.message);
    }
};

/**
 * 从 Firo 抓取赔率写入 juhe_matches.odds
 * 1. 拉取未填 odds 的 juhe_matches
 * 2. 按日期调 Firo sports-lottery/list 拿当天的所有 matchOddsList
 * 3. 在 lottery_jc_matches / lottery_bd_matches 中按主队/客队/时间±1h 找 firo matchId
 * 4. 写入 juhe_matches.odds
 */
const syncOddsFromFiro = async (env) => {
    try {
        // 1. 检查 odds 列是否存在
        let hasOdds = false;
        try {
            const { results: cols } = await env.DB.prepare(`PRAGMA table_info(juhe_matches)`).all();
            hasOdds = (cols || []).some(c => c.name === 'odds');
        } catch (e) {}
        if (!hasOdds) {
            console.log('juhe_matches has no odds column, skipping');
            return;
        }

        // 2. 取需要赔率的比赛（odds 为空，且比赛时间在未来 7 天内或 30 天内已结束）
        const { results: juheRows } = await env.DB.prepare(`
            SELECT id, home_team, away_team, match_time
            FROM juhe_matches
            WHERE (odds IS NULL OR odds = '')
              AND match_time IS NOT NULL
              AND match_time >= datetime('now', '-30 days')
              AND match_time <= datetime('now', '+7 days')
            ORDER BY match_time ASC
        `).all();

        if (!juheRows || juheRows.length === 0) {
            console.log('No juhe_matches need odds sync');
            await logSync(env, 'Odds-Debug', 'Firo-EMPTY', true, 0, `juheRows is empty, dateGroups.size=0`);
            return;
        }

        console.log(`Found ${juheRows.length} juhe_matches needing odds`);
        await logSync(env, 'Odds-Debug', 'Firo-INIT', true, juheRows.length, `juheRows.length=${juheRows.length}`);

        // 3. 按日期分组（避免重复调用 Firo）
        const dateGroups = new Map();
        for (const r of juheRows) {
            const d = (r.match_time || '').substring(0, 10); // YYYY-MM-DD
            if (d) {
                if (!dateGroups.has(d)) dateGroups.set(d, []);
                dateGroups.get(d).push(r);
            }
        }

        // 工具：根据 YYYY-MM-DD 加 N 天
        const addDays = (dateStr, days) => {
            const d = new Date(dateStr + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + days);
            return d.toISOString().substring(0, 10);
        };

        // 缓存 firoMap：跨日期复用 + 减少 API 调用
        const firoMapCache = new Map();

        // 加载某日期的 Firo 数据到 firoMap
        const loadFiroDate = async (date) => {
            if (firoMapCache.has(date)) return firoMapCache.get(date);

            const timestamp = Date.now().toString();
            // 关键：签名不传 params（与 /api/firo/jc 端点一致），Firo 验证期待不带 date 的签名
            const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY);

            if (!signature) {
                await logSync(env, 'Odds-Debug', `Firo-SigFail-${date}`, false, 0, `Signature generation failed`);
                firoMapCache.set(date, new Map());
                return firoMapCache.get(date);
            }

            const headers = {
                'X-API-Key': env.FIRO_API_KEY,
                'X-Timestamp': timestamp,
                'X-Signature': signature
            };

            const firoUrl = `https://www.firoapi.com/firo/sports-lottery/list?date=${date}`;
            try {
                const ctrl = new AbortController();
                const tmid = setTimeout(() => ctrl.abort(), 15000);
                const resp = await fetch(firoUrl, { headers, signal: ctrl.signal });
                clearTimeout(tmid);
                const firoData = await resp.json();

                if (firoData.code !== 200) {
                    await logSync(env, 'Odds-Debug', `Firo-NonOK-${date}`, false, 0, `code=${firoData.code}, msg=${firoData.message || 'unknown'}`);
                    firoMapCache.set(date, new Map());
                    return firoMapCache.get(date);
                }

                if (!Array.isArray(firoData.data)) {
                    await logSync(env, 'Odds-Debug', `Firo-NoData-${date}`, false, 0, `data is not array: ${typeof firoData.data}`);
                    firoMapCache.set(date, new Map());
                    return firoMapCache.get(date);
                }

                // 构建 map：按 matchId 索引
                const map = new Map();
                for (const m of firoData.data) {
                    const main = m.matchMain || {};
                    if (main.matchId) {
                        map.set(main.matchId, {
                            matchStartDate: main.matchStartDate || main.matchDate,
                            matchDate: main.matchDate,
                            matchTime: main.matchTime,
                            homeTeam: main.homeTeamName,
                            awayTeam: main.awayTeamName,
                            oddsList: m.matchOddsList || []
                        });
                    }
                }
                firoMapCache.set(date, map);
                return map;
            } catch (e) {
                await logSync(env, 'Odds-Debug', `Firo-Exception-${date}`, false, 0, e.message);
                firoMapCache.set(date, new Map());
                return firoMapCache.get(date);
            }
        };

        let totalUpdated = 0;

        // 4. 对 juhe 的每天，调 Firo ±1 天（应对开售/开赛日期差 1 天的情况）
        for (const [date, matches] of dateGroups) {
            console.log(`[syncOdds] Processing ${matches.length} matches for juhe date ${date}...`);

            // 加载 ±1 天的 Firo 数据（开售日期通常比开赛早 1 天）
            const datesToFetch = [addDays(date, -1), date, addDays(date, 1)];
            const firoMaps = [];
            for (const d of datesToFetch) {
                const m = await loadFiroDate(d);
                firoMaps.push(m);
            }
            const totalFiroMatches = firoMaps.reduce((sum, m) => sum + m.size, 0);
            console.log(`[syncOdds] Firo data for ${datesToFetch.join(',')}: ${totalFiroMatches} matches`);

            // 4.3 对每个 juheMatches 找对应 firo matchId 并写入赔率
            let debugFound = 0, debugNoLottery = 0, debugNoFiro = 0, debugFallback = 0;
            for (const jr of matches) {
                try {
                    // 在 lottery_jc_matches 中查找（主队/客队/时间 ±1h）
                    const { results: lotteryRows } = await env.DB.prepare(`
                        SELECT match_id, odds FROM lottery_jc_matches
                        WHERE home_team = ? AND away_team = ?
                          AND match_time IS NOT NULL
                          AND ABS(strftime('%s', match_time) - strftime('%s', ?)) <= 3600
                          AND match_id IS NOT NULL
                          AND odds IS NOT NULL AND odds != ''
                        LIMIT 1
                    `).bind(jr.home_team, jr.away_team, jr.match_time).all();

                    let firoMatchId = null;
                    let source = null;
                    let lotteryOddsJson = null;
                    if (lotteryRows && lotteryRows.length > 0) {
                        firoMatchId = lotteryRows[0].match_id;
                        source = 'JC';
                        lotteryOddsJson = lotteryRows[0].odds;
                    } else {
                        // 试 BD 表
                        const { results: bdRows } = await env.DB.prepare(`
                            SELECT match_id, odds FROM lottery_bd_matches
                            WHERE home_team = ? AND away_team = ?
                              AND match_time IS NOT NULL
                              AND ABS(strftime('%s', match_time) - strftime('%s', ?)) <= 3600
                              AND match_id IS NOT NULL
                              AND odds IS NOT NULL AND odds != ''
                            LIMIT 1
                        `).bind(jr.home_team, jr.away_team, jr.match_time).all();
                        if (bdRows && bdRows.length > 0) {
                            firoMatchId = bdRows[0].match_id;
                            source = 'BD';
                            lotteryOddsJson = bdRows[0].odds;
                        }
                    }

                    if (!firoMatchId) {
                        debugNoLottery++;
                        continue; // 未在 lottery 表中找到
                    }

                    // 在 firoMaps 中找（matchId 跨日期去重）
                    let oddsData = null;
                    for (const m of firoMaps) {
                        if (m.has(firoMatchId)) {
                            oddsData = m.get(firoMatchId);
                            break;
                        }
                    }

                    let oddsJson = null;
                    if (oddsData && oddsData.oddsList && oddsData.oddsList.length > 0) {
                        // 首选：Firo 实时数据
                        oddsJson = JSON.stringify({
                            source,
                            firoMatchId,
                            homeTeam: oddsData.homeTeam,
                            awayTeam: oddsData.awayTeam,
                            matchTime: `${oddsData.matchStartDate}T${oddsData.matchTime || '00:00'}:00Z`,
                            oddsList: oddsData.oddsList,
                            syncedAt: new Date().toISOString()
                        });
                        debugFound++;
                    } else if (lotteryOddsJson) {
                        // Fallback：Firo 没返回时，用 lottery 表的 odds（已开赛/已过期比赛用历史赔率）
                        try {
                            const parsed = JSON.parse(lotteryOddsJson);
                            // 统一为 oddsList 数组格式
                            const oddsList = [];
                            if (Array.isArray(parsed.oddsResults) && parsed.oddsResults.length > 0) {
                                // lottery 表的 oddsResults 格式: {code, combination, goalLine, odds, poolId, ...}
                                // 合并同 code 的 odds 到标准 pool
                                const byCode = new Map();
                                for (const r of parsed.oddsResults) {
                                    const c = r.code;
                                    if (!byCode.has(c)) byCode.set(c, { poolCode: c, goalLine: r.goalLine || '' });
                                    const cur = byCode.get(c);
                                    if (c === 'HAD' || c === 'HHAD' || c === 'HAFU') {
                                        if (r.combination === 'H' || r.combinationDesc === '胜') cur.homeOdds = r.odds;
                                        else if (r.combination === 'D' || r.combinationDesc === '平') cur.drawOdds = r.odds;
                                        else if (r.combination === 'A' || r.combinationDesc === '负') cur.awayOdds = r.odds;
                                    } else {
                                        // TTG/CRS 等单一组合池：附加在 description
                                        cur.combination = r.combination;
                                        cur.combinationDesc = r.combinationDesc;
                                        cur.odds = r.odds;
                                    }
                                }
                                for (const v of byCode.values()) oddsList.push(v);
                            } else if (parsed.h !== undefined) {
                                // 简单 h/d/a 格式
                                oddsList.push({
                                    poolCode: 'HAD',
                                    homeOdds: parseFloat(parsed.h),
                                    drawOdds: parseFloat(parsed.d),
                                    awayOdds: parseFloat(parsed.a),
                                    goalLine: parsed.goalLine || ''
                                });
                            } else if (Array.isArray(parsed)) {
                                // 已经是 array 格式（Firo 同款）
                                for (const p of parsed) oddsList.push(p);
                            }

                            if (oddsList.length === 0) {
                                debugNoFiro++;
                                continue;
                            }

                            oddsJson = JSON.stringify({
                                source,
                                firoMatchId,
                                homeTeam: jr.home_team,
                                awayTeam: jr.away_team,
                                matchTime: jr.match_time,
                                oddsList,
                                syncedAt: new Date().toISOString(),
                                fallback: true
                            });
                            debugFallback++;
                        } catch (e) {
                            debugNoFiro++;
                            continue;
                        }
                    } else {
                        debugNoFiro++;
                        continue; // Firo 没赔率，lottery 也没赔率（Define 状态）
                    }

                    // 4.4 写入 juhe_matches.odds
                    await env.DB.prepare(`
                        UPDATE juhe_matches SET odds = ? WHERE id = ?
                    `).bind(oddsJson, jr.id).run();
                    totalUpdated++;
                } catch (e) {
                    console.error(`[syncOdds] Error for match ${jr.id}:`, e.message);
                }
            }
            console.log(`[syncOdds] Date ${date} debug: found=${debugFound}, noLottery=${debugNoLottery}, noFiro=${debugNoFiro}, fallback=${debugFallback}`);
            // 把每日 debug 写入 sync_logs
            await logSync(env, 'Odds-Debug', `Firo-${date}`, true, debugFound + debugFallback, `found=${debugFound}, noLottery=${debugNoLottery}, noFiro=${debugNoFiro}, fallback=${debugFallback}, firoMaps=${totalFiroMatches}`);
        }

        console.log(`[syncOdds] Updated odds for ${totalUpdated} juhe_matches records`);
        await logSync(env, 'Odds', 'Firo', true, totalUpdated, `Updated ${totalUpdated} matches from ${dateGroups.size} days`);
    } catch (e) {
        console.error('Error in syncOddsFromFiro:', e.message);
        await logSync(env, 'Odds', 'Firo', false, 0, e.message);
    }
};

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

/**
 * 统一的同步日志记录函数
 * 用于所有 sync 任务的成功/失败记录
 * @param env Worker env
 * @param syncType 同步类型：'BD' | 'JC' | 'WorldcupNews' | 'WorldCup' | 'Renjiu' 等
 * @param source 数据源：'Firo' | 'Juhe-Key1' | 'Juhe-All' 等
 * @param success 是否成功（true/false）
 * @param count 处理条数（可选）
 * @param errorMsg 错误消息（可选）
 * @param errorCode 错误码（可选，如 10012）
 */
const logSync = async (env, syncType, source, success, count = 0, errorMsg = null, errorCode = null) => {
    try {
        const msg = errorMsg ? `${errorCode ? `[${errorCode}] ` : ''}${errorMsg}` : null;
        await env.DB.prepare(
            `INSERT INTO sync_logs (sync_type, draw_no, matches_count, source, success, error_msg) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
            syncType,
            'N/A',
            count,
            source,
            success ? 1 : 0,
            msg
        ).run();
    } catch (e) {
        console.error(`[logSync] Failed to log sync for ${syncType}/${source}:`, e.message);
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
        const matchTypeDes = f.match_type_des || null;
        const matchTypeName = f.match_type_name || null;

        // Delete existing record within 24 hours and re-insert with new data
        queries.push(
            env.DB.prepare(`
                DELETE FROM ${tableName}
                WHERE home_team = ? AND away_team = ?
                  AND abs(strftime('%s', match_time) - strftime('%s', ?)) <= 86400
            `).bind(home, away, time)
        );

        // Insert new record
        queries.push(
            env.DB.prepare(`
                INSERT INTO ${tableName} (home_team, away_team, match_time, league, score, status, home_logo, away_logo, match_type_des, match_type_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(home, away, time, league, score, status, homeLogo, awayLogo, matchTypeDes, matchTypeName)
        );
    });

    try {
        await env.DB.batch(queries);
        console.log(`Successfully synced ${matchesData.length} matches to ${tableName}.`);
        console.log(`Batch executed: ${queries.length} queries (${matchesData.length} matches * 2 queries)`);
    } catch (e) {
        console.error(`Error saving matches to ${tableName}:`, e);
        console.error(`Query count: ${queries.length}`);
        console.error(`First match: ${JSON.stringify(matchesData[0])}`);
    }
};

const getJuheApiKey = (env) => {
    const keys = [
        env.JUHE_API_KEY,
        env.JUHE_API_KEY_2,
        env.JUHE_API_KEY_3
    ].filter(Boolean);
    
    return keys[0] || null;
};

const countryToFlag = {
    '阿根廷': 'ar', '巴西': 'br', '法国': 'fr', '德国': 'de', '意大利': 'it',
    '英格兰': 'gb-eng', '西班牙': 'es', '荷兰': 'nl', '比利时': 'be', '葡萄牙': 'pt',
    '克罗地亚': 'hr', '丹麦': 'dk', '波兰': 'pl', '瑞士': 'ch', '奥地利': 'at',
    '捷克': 'cz', '瑞典': 'se', '威尔士': 'gb-wls', '塞尔维亚': 'rs', '乌克兰': 'ua',
    '墨西哥': 'mx', '美国': 'us', '加拿大': 'ca', '巴拿马': 'pa', '哥斯达黎加': 'cr',
    '日本': 'jp', '韩国': 'kr', '伊朗': 'ir', '沙特阿拉伯': 'sa', '卡塔尔': 'qa',
    '澳大利亚': 'au', '新西兰': 'nz',
    '摩洛哥': 'ma', '突尼斯': 'tn', '塞内加尔': 'sn', '喀麦隆': 'cm', '加纳': 'gh',
    '埃及': 'eg', '尼日利亚': 'ng', '阿尔及利亚': 'dz', '科特迪瓦': 'ci',
    '哥伦比亚': 'co', '乌拉圭': 'uy', '秘鲁': 'pe', '智利': 'cl', '厄瓜多尔': 'ec',
    '巴拉圭': 'py', '委内瑞拉': 've', '玻利维亚': 'bo',
    '中国': 'cn', '印度': 'in', '印度尼西亚': 'id', '泰国': 'th', '越南': 'vn',
    '土耳其': 'tr', '希腊': 'gr', '挪威': 'no', '芬兰': 'fi', '俄罗斯': 'ru',
    '苏格兰': 'gb-sct', '爱尔兰': 'ie', '匈牙利': 'hu', '罗马尼亚': 'ro',
    '斯洛伐克': 'sk', '斯洛文尼亚': 'si', '保加利亚': 'bg', '北马其顿': 'mk',
    '南非': 'za', '民主刚果': 'cd', '加蓬': 'ga', '阿尔巴尼亚': 'al',
    '波黑': 'ba', '黑山': 'me', '冰岛': 'is', '以色列': 'il'
};

const leagueToCountry = {
    '芬超': 'fi', '芬甲': 'fi', '芬兰': 'fi',
    '瑞典超': 'se', '瑞典甲': 'se', '瑞典': 'se',
    '挪超': 'no', '挪甲': 'no', '挪威': 'no',
    '丹超': 'dk', '丹麦': 'dk', '丹甲': 'dk',
    '波兰甲': 'pl', '波兰超': 'pl', '波兰': 'pl',
    '葡超': 'pt', '葡甲': 'pt', '葡萄牙': 'pt',
    '瑞士超': 'ch', '瑞士甲': 'ch', '瑞士': 'ch',
    '罗甲': 'ro', '罗马尼亚': 'ro',
    '意乙': 'it', '意大利': 'it', '意甲': 'it',
    '英超': 'gb-eng', '英冠': 'gb-eng', '英甲': 'gb-eng', '英乙': 'gb-eng', '英格兰': 'gb-eng',
    '西乙': 'es', '西班牙': 'es', '西甲': 'es',
    '法乙': 'fr', '法国': 'fr', '法甲': 'fr',
    '苏超': 'gb-sct', '苏冠': 'gb-sct', '苏格兰': 'gb-sct',
    '比甲': 'be', '比利时': 'be',
    '爱超': 'ie', '爱尔兰超': 'ie', '爱尔兰': 'ie', '爱甲': 'ie',
    '美职篮': 'us', '美职冰': 'us', '美足': 'us', '美国': 'us',
    '澳超': 'au', '澳洲': 'au', '澳大利亚': 'au',
    'J1联赛': 'jp', 'J2联赛': 'jp', '日本': 'jp', '日职': 'jp', '日乙': 'jp',
    'K联赛': 'kr', '韩国': 'kr', '韩职': 'kr',
    '中超': 'cn', '中国': 'cn', '中甲': 'cn',
    '智利甲': 'cl', '智利': 'cl',
    '巴西甲': 'br', '巴西': 'br',
    '阿甲': 'ar', '阿根廷': 'ar',
    '墨超': 'mx', '墨西哥': 'mx',
    '土超': 'tr', '土耳其': 'tr',
    '希腊超': 'gr', '希腊': 'gr',
    '俄超': 'ru', '俄罗斯': 'ru',
    '荷甲': 'nl', '荷兰': 'nl',
    '奥甲': 'at', '奥地利': 'at',
    '匈甲': 'hu', '匈牙利': 'hu',
    '克亚': 'hr', '克罗地亚': 'hr',
    '塞超': 'rs', '塞尔维亚': 'rs',
    '乌超': 'ua', '乌克兰': 'ua',
    '冰岛超': 'is', '冰岛': 'is',
    '以超': 'il', '以色列': 'il'
};

const getFlagUrl = (countryName) => {
    const code = countryToFlag[countryName];
    if (code) {
        return `https://flagcdn.com/w80/${code}.png`;
    }
    return '';
};

const getFlagUrlByLeague = (leagueName) => {
    const countryCode = leagueToCountry[leagueName];
    if (countryCode) {
        return `https://flagcdn.com/w80/${countryCode}.png`;
    }
    return '';
};

const syncJuheMatches = async (env, options = {}) => {
    const leagues = ['yingchao', 'xijia', 'dejia', 'yijia', 'fajia', 'zhongchao'];
    const worldcupLeague = 'worldcup';
    const timeout = 120 * 1000;
    const keys = [
        env.JUHE_API_KEY,
        env.JUHE_API_KEY_2,
        env.JUHE_API_KEY_3
    ].filter(Boolean);

    // Sync regular leagues
    for (const type of leagues) {
        let success = false;
        let lastError = null;

        for (let ki = 0; ki < keys.length; ki++) {
            const juheKey = keys[ki];
            if (success) break;

            try {
                console.log(`Syncing Juhe league: ${type} with key #${ki+1}: ${juheKey.substring(0, 8)}...`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                const response = await fetch(`http://apis.juhe.cn/fapig/football/query?key=${juheKey}&type=${type}`, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const data = await response.json();

                if (data.error_code === 0 && data.result && data.result.matchs) {
                    const matches = [];
                    data.result.matchs.forEach(day => {
                        day.list.forEach(m => {
                            const score1 = m.team1_score || '-';
                            const score2 = m.team2_score || '-';
                            const score = `${score1} - ${score2}`;

                            matches.push({
                                home: m.team1,
                                away: m.team2,
                                home_logo: m.team1_logo,
                                away_logo: m.team2_logo,
                                league: data.result.title,
                                date: `${day.date}T${m.time_start}:00Z`,
                                score: score,
                                status: m.status_text
                            });
                        });
                    });
                    await saveMatchesToDb(env, matches, 'juhe_matches');
                    success = true;
                    console.log(`Successfully synced ${matches.length} matches for ${type}`);
                    await logSync(env, 'League', `Juhe-Key${ki+1}`, true, matches.length, `League: ${type}`);
                } else if (data.error_code === 10012) {
                    console.log(`API key #${ki+1} ${juheKey.substring(0, 8)} quota exceeded, trying next key...`);
                    await logSync(env, 'League', `Juhe-Key${ki+1}`, false, 0, `League ${type} quota exceeded`, 10012);
                    lastError = `quota exceeded (10012)`;
                } else {
                    console.log(`API error for ${type}: ${data.reason}`);
                    await logSync(env, 'League', `Juhe-Key${ki+1}`, false, 0, `League ${type}: ${data.reason || 'unknown'}`, data.error_code);
                    lastError = data.reason || `error_code ${data.error_code}`;
                }
            } catch (e) {
                console.error(`Error syncing Juhe league ${type} with key #${ki+1}:`, e.message);
                await logSync(env, 'League', `Juhe-Key${ki+1}`, false, 0, `League ${type} network: ${e.message}`);
                lastError = `network: ${e.message}`;
            }
        }

        if (!success) {
            console.log(`Failed to sync ${type} with all available keys`);
            await logSync(env, 'League', 'Juhe-All', false, 0, `League ${type} all keys failed: ${lastError}`);
        }
    }
    
    // Sync World Cup using dedicated API (id=616) with key pool fallback
    console.log(`Syncing World Cup matches...`);
    let worldcupSuccess = false;

    const worldcupKeys = getWorldcupApiKeys(env);

    if (worldcupKeys.length === 0) {
        console.log(`World Cup API keys not configured, skipping...`);
    } else {
        // Try each key in order, fallback on rate limit
        for (let ki = 0; ki < worldcupKeys.length && !worldcupSuccess; ki++) {
            const worldcupKey = worldcupKeys[ki];
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                // World Cup API endpoint (id=616)
                const response = await fetch(`https://apis.juhe.cn/fapigw/worldcup2026/schedule?key=${worldcupKey}`, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const data = await response.json();

                // 限流 (10012) 时切换下一个 key
                if (data.error_code === 10012 || data.error_code === 10001) {
                    console.log(`World Cup schedule key #${ki+1} rate limited (${data.error_code}), trying next...`);
                    await logSync(env, 'WorldCup', `Juhe-Key${ki+1}`, false, 0, data.reason || 'rate limited', data.error_code);
                    continue;
                }

                console.log(`World Cup API (key #${ki+1}) response keys: ${Object.keys(data).join(', ')}`);
                console.log(`World Cup API result keys: ${data.result ? Object.keys(data.result).join(', ') : 'null'}`);

                if (data.error_code === 0 && data.result) {
                    const matches = [];
                    const scheduleList = data.result.data || [];

                    console.log(`Found ${scheduleList.length} schedule groups from World Cup API`);

                    scheduleList.forEach(dayGroup => {
                         const dayMatches = dayGroup.schedule_list || [];
                         dayMatches.forEach(m => {
                             // Skip matches where teams are not determined yet
                             // Contains "胜者", "败者", "/" (group combination), or single letter + number pattern
                             if (m.host_team_name.includes('胜者') || m.guest_team_name.includes('胜者') ||
                                 m.host_team_name.includes('败者') || m.guest_team_name.includes('败者') ||
                                 m.host_team_name.includes('/') || m.guest_team_name.includes('/') ||
                                 /^[A-Z]\d?$/.test(m.host_team_name) || /^[A-Z]\d?$/.test(m.guest_team_name)) {
                                 return;
                             }

                             const status = m.match_status === '1' ? '未开赛' :
                                            m.match_status === '2' ? '比赛中' :
                                            m.match_status === '3' ? '完赛' : m.match_des || '未知';

                             // Convert date_time "2026-07-03 07:00:00" to "2026-07-03T07:00:00Z"
                             const matchDate = m.date_time ? m.date_time.replace(' ', 'T') + 'Z' : `${m.date}T00:00:00Z`;

                             matches.push({
                             home: m.host_team_name,
                             away: m.guest_team_name,
                             home_logo: getFlagUrl(m.host_team_name),
                             away_logo: getFlagUrl(m.guest_team_name),
                             league: '世界杯',
                             date: matchDate,
                             score: `${m.host_team_score || '-'}-${m.guest_team_score || '-'}`,
                             status: status,
                             match_type_des: m.match_type_des || null,
                             match_type_name: m.match_type_name || null
                         });
                     });
                 });

                console.log(`Prepared ${matches.length} World Cup matches to save`);
                if (matches.length > 0) {
                    console.log(`First match: ${JSON.stringify(matches[0])}`);
                    console.log(`Calling saveMatchesToDb...`);
                    try {
                        await saveMatchesToDb(env, matches, 'juhe_matches');
                        worldcupSuccess = true;
                        console.log(`Successfully synced ${matches.length} World Cup matches`);
                        await logSync(env, 'WorldCup', `Juhe-Key${ki+1}`, true, matches.length);
                    } catch (err) {
                        console.error(`Error in saveMatchesToDb: ${err.message}`);
                        console.error(err.stack);
                        await logSync(env, 'WorldCup', `Juhe-Key${ki+1}`, false, 0, `saveMatchesToDb error: ${err.message}`);
                    }
                } else {
                    console.log(`No World Cup matches found in API response`);
                    await logSync(env, 'WorldCup', `Juhe-Key${ki+1}`, false, 0, 'No matches in response');
                }
            } else {
                console.log(`World Cup API error: ${data.reason || data.error_code}`);
                await logSync(env, 'WorldCup', `Juhe-Key${ki+1}`, false, 0, data.reason || 'API error', data.error_code);
            }
            } catch (e) {
                console.error(`Error syncing World Cup (key #${ki+1}):`, e.message);
                // 网络错误时也尝试下一个 key
                await logSync(env, 'WorldCup', `Juhe-Key${ki+1}`, false, 0, `Network error: ${e.message}`);
            }
        } // end for worldcupKeys
    }

    if (!worldcupSuccess) {
        console.log(`Failed to sync World Cup`);
        await logSync(env, 'WorldCup', 'Juhe-All', false, 0, 'All keys exhausted or unavailable');
    }

    // 同步世界杯资讯（2 小时一次：只在偶数小时跑）
    // 手动触发 /api/juhe/sync 时不调（避免与 /api/worldcup/news/sync 重复）
    if (options.skipNews) {
        console.log(`[syncJuheMatches] Skipping World Cup news sync (manual trigger)`);
    } else {
        const currentHour = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
        // getUTCHours + 8 = 北京时间，2 % 2 = 0 表示偶数小时
        if (currentHour % 2 === 0) {
            await syncWorldcupNews(env);
        } else {
            console.log(`[World Cup news] Skipped (odd hour ${currentHour}, runs only at even hours)`);
        }
    }

    // 同步 lottery 表的 football_info 到 juhe_matches
    await syncFootballInfoToJuheMatches(env);

    // 同步赔率（从 Firo）
    await syncOddsFromFiro(env);
};

/**
 * 获取世界杯 API key 池（自动去重有效 key）
 * @param {Object} env - Cloudflare Workers env
 * @returns {string[]} key 数组（按优先级排序）
 */
const getWorldcupApiKeys = (env) => {
    const keys = [
        env.WORLDCUP_API_KEY,
        env.WORLDCUP_API_KEY_2,
        env.WORLDCUP_API_KEY_3,
        env.WORLDCUP_API_KEY_4
    ].filter(k => k && k.trim().length > 0);
    return keys;
};

/**
 * 同步世界杯资讯（juhe API id=616, endpoint=worldcup2026/news）
 * 自动尝试 key 池：当前 key 限流时自动切换下一个
 */
const syncWorldcupNews = async (env) => {
    const keys = getWorldcupApiKeys(env);
    if (keys.length === 0) {
        console.log('World Cup news API key not configured, skipping...');
        return;
    }

    // 读取上次成功的 key 索引（轮询机制）
    const stateRow = await env.DB.prepare(
        "SELECT value FROM app_state WHERE key = 'worldcup_news_key_index'"
    ).first().catch(() => null);
    const startIndex = stateRow ? parseInt(stateRow.value) % keys.length : 0;

    // 顺序尝试每个 key（从轮询起点开始），遇到 10012 限流时切换下一个
    for (let i = 0; i < keys.length; i++) {
        const idx = (startIndex + i) % keys.length;
        const worldcupKey = keys[idx];
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            const response = await fetch(`https://apis.juhe.cn/fapigw/worldcup2026/news?key=${worldcupKey}&num=30`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await response.json();

            // 限流 (10012) 或错误 10001 时切换下一个 key
            if (data.error_code === 10012 || data.error_code === 10001) {
                console.log(`World Cup news key #${idx+1} rate limited (${data.error_code}), trying next...`);
                continue;
            }

            if (data.error_code !== 0 || !data.result?.data) {
                console.log(`World Cup news API error: ${data.reason || data.error_code}`);
                try {
                    await env.DB.prepare(
                        `INSERT INTO sync_logs (sync_type, draw_no, matches_count, source, success, error_msg) VALUES (?, ?, ?, ?, 0, ?)`
                    ).bind('WorldcupNews', 'N/A', 0, `Juhe-Key${idx+1}`, data.reason || 'unknown error').run();
                } catch (e) {}
                return;
            }

            const items = data.result.data;
            console.log(`World Cup news (key #${idx+1}): fetched ${items.length} items`);

            // 第一步：先 UPSERT 列表数据
            const stmt = env.DB.prepare(`
                INSERT INTO worldcup_news (id, title, img, publish_time, news_source)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    img = excluded.img,
                    publish_time = excluded.publish_time,
                    news_source = excluded.news_source
            `);
            const batch = items.map(n => stmt.bind(n.id, n.title, n.img || '', n.publish_time || '', n.news_source || ''));
            await env.DB.batch(batch);

            // 第二步：批量抓取详情（用 worldcup2026/newsinfo 端点，全小写）
            let detailSuccess = 0;
            let detailFailed = 0;
            for (const item of items) {
                try {
                    const ctrl = new AbortController();
                    const tmid = setTimeout(() => ctrl.abort(), 8000);
                    const detailResp = await fetch(`https://apis.juhe.cn/fapigw/worldcup2026/newsinfo?key=${worldcupKey}&id=${item.id}`, {
                        signal: ctrl.signal
                    });
                    clearTimeout(tmid);
                    const detailData = await detailResp.json();

                    if (detailData.error_code === 10012 || detailData.error_code === 10001) {
                        // 当前 key 限流，跳过详情抓取
                        console.log(`World Cup news detail: key #${idx+1} rate limited (${detailData.error_code}), skipping details`);
                        await logSync(env, 'WorldcupNews', `Juhe-Key${idx+1}-detail`, false, detailSuccess, `Detail rate limited, ${detailFailed} failed`, detailData.error_code);
                        break;
                    }

                    if (detailData.error_code === 0 && detailData.result?.data?.content) {
                        const content = detailData.result.data.content;
                        await env.DB.prepare(`
                            UPDATE worldcup_news SET content = ? WHERE id = ?
                        `).bind(content, item.id).run();
                        detailSuccess++;
                    } else {
                        detailFailed++;
                    }
                } catch (e) {
                    detailFailed++;
                }
            }
            console.log(`World Cup news detail: ${detailSuccess} success, ${detailFailed} failed`);

            // 记录主同步成功日志
            await logSync(env, 'WorldcupNews', `Juhe-Key${idx+1}`, true, items.length, `${detailSuccess} with content, ${detailFailed} missing`);
            console.log(`World Cup news synced: ${items.length} items, ${detailSuccess} with content`);

            // 成功：更新下次轮询起点为下一个 key（均摊调用）
            try {
                await env.DB.prepare(
                    "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('worldcup_news_key_index', ?, datetime('now'))"
                ).bind(String((idx + 1) % keys.length)).run();
            } catch (e) {}

            return; // 成功，退出
        } catch (e) {
            console.error(`World Cup news key #${idx+1} error:`, e.message);
            // 网络错误时也尝试下一个 key
            if (i === keys.length - 1) {
                // 已是最后一个 key，记录失败日志
                await logSync(env, 'WorldcupNews', 'Juhe-All', false, 0, e.message);
                // 全部 key 失败，重置索引为 0
                try {
                    await env.DB.prepare(
                        "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('worldcup_news_key_index', '0', datetime('now'))"
                    ).run();
                } catch (e3) {}
            }
        }
    }
    console.log('All World Cup news keys exhausted');
};

const fetchRenjiuPeriods = async () => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120 * 1000);
        
        const response = await fetch('https://www.500.com/kaijiang/sfc/lskj/', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) return [];
        const html = await response.text();
        
        const periodRegex = /"(\d{5})","(\d{4}-\d{2}-\d{2})","[^"]+"/g;
        const periods = [];
        let match;
        
        while ((match = periodRegex.exec(html)) !== null) {
            const period = match[1];
            if (period && !periods.includes(period)) {
                periods.push(period);
            }
        }
        
        console.log(`Found ${periods.length} valid periods from HTML`);
        return periods.sort((a, b) => b - a);
    } catch (e) {
        console.error('Error fetching renjiu periods:', e);
        return [];
    }
};

const fetchRenjiuPeriodMatches = async (env, period) => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120 * 1000);
        
        const response = await fetch(`https://www.500.com/kaijiang/sfc/${period}.html`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) return [];
        const html = await response.text();
        
        const matches = [];
        
        const teamnameTopRegex = /<div class="teamname teamname-top"[^>]*>[\s\S]*?<\/div>\s*<div class="vs"[^>]*>[\s\S]*?<\/div>\s*<div class="teamname"[^>]*>[\s\S]*?<\/div>/g;
        const teamMatches = html.match(teamnameTopRegex) || [];
        
        const scoreRegex = /<td class="td-score"[^>]*><span[^>]*>([^<]+)<\/span><\/td>/g;
        const scoreMatches = [...html.matchAll(scoreRegex)];
        
        for (let i = 0; i < teamMatches.length; i++) {
            const teamBlock = teamMatches[i];
            
            const allDivs = teamBlock.match(/<div class="teamname[^"]*"[^>]*>([\s\S]*?)<\/div>/g);
            
            if (allDivs && allDivs.length >= 2) {
                const cleanSpans = (divHtml) => {
                    const chars = divHtml.match(/<span[^>]*>([^<]*)<\/span>/g) || [];
                    return chars.map(s => s.replace(/<[^>]+>/g, '')).join('');
                };
                
                const homeTeam = cleanSpans(allDivs[0]);
                const awayTeam = cleanSpans(allDivs[1]);
                
                let score = '';
                let status = '';
                
                if (scoreMatches[i]) {
                    score = scoreMatches[i][1];
                    if (score.includes('-')) {
                        status = '已开奖';
                    } else {
                        status = '未开奖';
                    }
                }
                
                if (homeTeam && awayTeam) {
                    matches.push({
                        home_team: homeTeam,
                        away_team: awayTeam,
                        match_time: '',
                        score: score,
                        status: status,
                        league: ''
                    });
                }
            }
        }
        
        return matches;
    } catch (e) {
        console.error(`Error fetching renjiu period ${period} matches:`, e);
        return [];
    }
};

const syncRenjiuMatches = async (env) => {
    const teamVariantsMap = {
        '曼彻斯特联': ['曼彻斯特联', '曼联'],
        '曼彻斯特城': ['曼彻斯特城', '曼城'],
        '纽卡斯尔联': ['纽卡斯尔联', '纽卡斯尔'],
        '托特纳姆热刺': ['托特纳姆热刺', '热刺'],
        '切尔西': ['切尔西'],
        '阿森纳': ['阿森纳'],
        '利物浦': ['利物浦'],
        '曼联': ['曼彻斯特联', '曼联'],
        '曼城': ['曼彻斯特城', '曼城']
    };
    
    const periods = await fetchRenjiuPeriods();
    console.log(`Found ${periods.length} renjiu periods`);
    
    for (const period of periods) {
        const { results } = await env.DB.prepare("SELECT id FROM renjiu_periods WHERE period = ?").bind(period).all();
        
        if (results.length === 0) {
            await env.DB.prepare("INSERT INTO renjiu_periods (period) VALUES (?)").bind(period).run();
            console.log(`New period detected: ${period}, fetching matches...`);
            
            const matches = await fetchRenjiuPeriodMatches(env, period);
            console.log(`Fetched ${matches.length} matches for period ${period}`);
            
            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                await env.DB.prepare(`
                    INSERT INTO renjiu_matches (period, match_index, home_team, away_team, match_time, score, status, league)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(period, match_index) DO UPDATE SET
                        home_team = excluded.home_team,
                        away_team = excluded.away_team,
                        match_time = excluded.match_time,
                        score = excluded.score,
                        status = excluded.status,
                        league = excluded.league
                `).bind(period, i, m.home_team, m.away_team, m.match_time, m.score, m.status, m.league).run();
                
                const homeVariants = teamVariantsMap[m.home_team] || [m.home_team];
                const awayVariants = teamVariantsMap[m.away_team] || [m.away_team];
                
                let matchedJuheMatch = null;
                
                for (const hVar of homeVariants) {
                    for (const aVar of awayVariants) {
                        const { results: juheMatches } = await env.DB.prepare(`
                            SELECT id, match_time, home_team, away_team FROM juhe_matches 
                            WHERE home_team LIKE ? AND away_team LIKE ?
                            AND (period IS NULL OR period = '')
                            LIMIT 5
                        `).bind(`%${hVar}%`, `%${aVar}%`).all();
                        
                        for (const jm of juheMatches) {
                            const jmHomeMatch = homeVariants.some(v => jm.home_team.includes(v) || v.includes(jm.home_team));
                            const jmAwayMatch = awayVariants.some(v => jm.away_team.includes(v) || v.includes(jm.away_team));
                            
                            if (jmHomeMatch && jmAwayMatch) {
                                matchedJuheMatch = jm;
                                break;
                            }
                        }
                        if (matchedJuheMatch) break;
                    }
                    if (matchedJuheMatch) break;
                }
                
                if (matchedJuheMatch) {
                    await env.DB.prepare(`
                        UPDATE juhe_matches 
                        SET period = ? 
                        WHERE id = ?
                    `).bind(period, matchedJuheMatch.id).run();
                    console.log(`Linked juhe match ${matchedJuheMatch.home_team} vs ${matchedJuheMatch.away_team} to period ${period}`);
                }
            }
            console.log(`Saved ${matches.length} matches for period ${period}`);
        }
    }
};

const fetchLive500Matches = async () => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120 * 1000);
        
        const response = await fetch('https://live.500.com/wanchang.php', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) return [];
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('gbk');
        const html = decoder.decode(buffer);
        
        const matches = [];
        
        const trRegex = /<tr[^>]*gy=["']([^"']*)["'][^>]*>([\s\S]*?)<\/tr>/g;
        let trMatch;
        
        while ((trMatch = trRegex.exec(html)) !== null) {
            const gyInfo = trMatch[1];
            const trContent = trMatch[2];
            
            const homeMatch = trContent.match(/<span class="mainName"[^>]*>([^<]*)<\/span>/);
            const awayMatch = trContent.match(/<span class="clientName"[^>]*>([^<]*)<\/span>/);
            
            const scoreMatch = trContent.match(/<td[^>]*class="red"[^>]*>([\d\s-]+)<\/td>/);
            
            if (homeMatch && awayMatch && scoreMatch) {
                const homeTeam = homeMatch[1].trim();
                const awayTeam = awayMatch[1].trim();
                const score = scoreMatch[1].trim();
                
                if (homeTeam && awayTeam && score && score.match(/\d+\s*-\s*\d+/)) {
                    matches.push({
                        home: homeTeam,
                        away: awayTeam,
                        score: score
                    });
                }
            }
        }
        
        console.log(`Fetched ${matches.length} matches from live.500.com`);
        return matches;
    } catch (e) {
        console.error('Error fetching live.500.com:', e);
        return [];
    }
};

const supplementScoresFromLive500 = async (env) => {
    console.log('Supplementing scores from live.500.com...');
    
    const liveMatches = await fetchLive500Matches();
    
    if (liveMatches.length === 0) {
        console.log('No matches found from live.500.com');
        return;
    }
    
    const { results: juheMatches } = await env.DB.prepare(`
        SELECT id, home_team, away_team, score, match_time 
        FROM juhe_matches 
        WHERE score IS NULL OR score = '' OR score = '- -' OR score = '- - -'
    `).all();
    
    console.log(`Found ${juheMatches.length} matches with missing scores`);
    
    let supplementedCount = 0;
    
    for (const match of juheMatches) {
        for (const liveMatch of liveMatches) {
            const homeMatch = match.home_team.includes(liveMatch.home) || liveMatch.home.includes(match.home_team);
            const awayMatch = match.away_team.includes(liveMatch.away) || liveMatch.away.includes(match.away_team);
            
            if (homeMatch && awayMatch && liveMatch.score && liveMatch.score.includes('-')) {
                await env.DB.prepare(`
                    UPDATE juhe_matches 
                    SET score = ? 
                    WHERE id = ?
                `).bind(liveMatch.score, match.id).run();
                
                console.log(`Supplemented score for ${match.home_team} vs ${match.away_team}: ${liveMatch.score}`);
                supplementedCount++;
                break;
            }
        }
    }
    
    console.log(`Supplemented ${supplementedCount} scores from live.500.com`);
};

const getRenjiuScore = async (env, homeTeam, awayTeam, matchTime) => {
    const teamVariants = {
        '曼彻斯特联': ['曼彻斯特联', '曼联', '曼彻斯特联'],
        '曼彻斯特城': ['曼彻斯特城', '曼城'],
        '纽卡斯尔联': ['纽卡斯尔联', '纽卡斯尔'],
        '托特纳姆热刺': ['托特纳姆热刺', '热刺'],
        '曼彻斯特联': ['曼彻斯特联', '曼联']
    };
    
    const homeVariants = teamVariants[homeTeam] || [homeTeam];
    const awayVariants = teamVariants[awayTeam] || [awayTeam];
    
    const juheMatchTime = new Date(matchTime);
    const timeDiff24h = 24 * 60 * 60 * 1000;
    
    for (const hVar of homeVariants) {
        for (const aVar of awayVariants) {
            const { results } = await env.DB.prepare(`
                SELECT score, home_team, away_team, created_at FROM renjiu_matches 
                WHERE (home_team = ? AND away_team = ?)
                OR (home_team = ? AND away_team = ?)
                AND score IS NOT NULL AND score != '' AND score != '-'
                ORDER BY created_at DESC
                LIMIT 10
            `).bind(hVar, aVar, aVar, hVar).all();
            
            if (results.length > 0) {
                for (const result of results) {
                    const renjuHomeTeam = result.home_team;
                    const renjuAwayTeam = result.away_team;
                    
                    const homeMatch = homeVariants.some(v => v === renjuHomeTeam || renjuHomeTeam.includes(v) || v.includes(renjuHomeTeam));
                    const awayMatch = awayVariants.some(v => v === renjuAwayTeam || renjuAwayTeam.includes(v) || v.includes(renjuAwayTeam));
                    
                    if (homeMatch && awayMatch) {
                        const renjuCreatedTime = new Date(result.created_at);
                        const timeDiff = Math.abs(juheMatchTime.getTime() - renjuCreatedTime.getTime());
                        const timeDiffHours = timeDiff / (1000 * 60 * 60);
                        
                        if (timeDiffHours <= 48) {
                            console.log(`Found matching match within 48h: ${renjuHomeTeam} vs ${renjuAwayTeam}, time diff: ${timeDiffHours.toFixed(1)} hours`);
                            return result.score;
                        }
                    }
                }
            }
        }
    }
    
    return null;
};

const normalizeTeamName = (teamName) => {
    const normalizationMap = {
        '曼彻斯特联': ['曼联', '曼彻斯特联', '曼联'],
        '曼彻斯特城': ['曼城', '曼彻斯特城', '曼城'],
        '纽卡斯尔联': ['纽卡斯尔', '纽卡斯尔联'],
        '托特纳姆热刺': ['热刺', '托特纳姆热刺'],
        '切尔西': ['切尔西'],
        '阿森纳': ['阿森纳'],
        '利物浦': ['利物浦'],
        '曼彻斯特联': ['曼联', '曼彻斯特联']
    };
    
    for (const [normalized, variants] of Object.entries(normalizationMap)) {
        if (variants.includes(teamName)) {
            return normalized;
        }
    }
    return teamName;
};

export default {
    async scheduled(event, env, ctx) {
        const cron = event.crons?.[0] || '';
        console.log(`Cron job triggered: ${cron}`);

        if (cron === '0 */4 * * *') {
            console.log('Running 4-hour sync: Juhe matches + Firo lottery (BD/JC) + match results + odds...');
            await syncJuheMatches(env);
            await syncFiroLottery(env);
            await syncFiroMatchResults(env);
            await syncOddsFromFiro(env);
            console.log('4-hour sync completed.');
        } else {
            console.log('Running default sync...');
            const matchesData = await fetchTodayMatches(env);
            await saveMatchesToDb(env, matchesData);
            await syncJuheMatches(env);
            await syncFiroLottery(env);
            console.log('Default sync completed.');
        }
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
                            id: r.id,
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
                'zhongchao': 'zhongchao',
                'worldcup': 'worldcup',
                'world cup': 'worldcup',
                '世界杯': 'worldcup',
                'bd': 'lottery_bd',
                '北单': 'lottery_bd',
                'jc': 'lottery_jc',
                '竞彩': 'lottery_jc'
            };

            const typeToTitle = {
                'yingchao': '英格兰超级联赛',
                'xijia': '西班牙甲级联赛',
                'dejia': '德国甲级联赛',
                'yijia': '意大利甲级联赛',
                'fajia': '法国甲级联赛',
                'zhongchao': '中国超级联赛',
                'jiangsu': '苏格兰超级联赛',
                'worldcup': '世界杯'
            };

            const targetLeague = leagueParam || query || 'yingchao';
            const type = leagueMapping[targetLeague] || targetLeague;
            const title = typeToTitle[type] || targetLeague;

            try {
                // Handle lottery data queries (BD and JC)
                if (type === 'lottery_bd' || type === 'lottery_jc') {
                    const tableName = type === 'lottery_bd' ? 'lottery_bd_matches' : 'lottery_jc_matches';
                    const lotteryTitle = type === 'lottery_bd' ? '北单' : '竞彩';
                    
                    let whereClause = "";
                    const params = [];
                    
                    if (query) {
                        whereClause = "WHERE (home_team LIKE ? OR away_team LIKE ?)";
                        params.push(`%${query}%`, `%${query}%`);
                    }
                    
                    if (startDate) {
                        whereClause += whereClause ? " AND match_time >= ? " : "WHERE match_time >= ? ";
                        params.push(startDate);
                    }
                    if (endDate) {
                        whereClause += whereClause ? " AND match_time <= ? " : "WHERE match_time <= ? ";
                        params.push(endDate + "T23:59:59Z");
                    }
                    
                    const countSql = `SELECT COUNT(*) as total FROM ${tableName} ${whereClause}`;
                    const { results: countResults } = await env.DB.prepare(countSql).bind(...params).all();
                    const total = countResults[0].total;
                    
                    let sql = `SELECT * FROM ${tableName} ${whereClause} ORDER BY match_time DESC LIMIT ? OFFSET ?`;
                    const { results: matches } = await env.DB.prepare(sql).bind(...params, pageSize, offset).all();
                    
                    return new Response(JSON.stringify({
                        metadata: {
                            total,
                            page,
                            pageSize,
                            totalPages: Math.ceil(total / pageSize),
                            type: lotteryTitle
                        },
                        matches: matches.map(m => ({
                            id: m.id,
                            match_id: m.match_id || null,
                            has_football_info: m.football_info ? true : false,
                            home: m.home_team,
                            away: m.away_team,
                            home_logo: m.home_logo || '',
                            away_logo: m.away_logo || '',
                            league: m.league || lotteryTitle,
                            date: m.match_time,
                            score: m.score || '- -',
                            status: m.status,
                            odds: m.odds ? JSON.parse(m.odds) : null
                        }))
                    }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                // Auto-update non-finished games started more than 10000000 hours ago
                // Note: DB stores match_time as Beijing Time (UTC+8) despite the 'Z' suffix
                // So we need to generate Beijing Time - 10000000 hours in ISO format
                const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000); // Convert to Beijing Time
                const tenMillionHoursAgo = new Date(beijingTime.getTime() - 10000000 * 60 * 60 * 1000).toISOString();
                await env.DB.prepare(`
                    UPDATE juhe_matches
                    SET status = '完赛'
                    WHERE status != '完赛' AND match_time <= ?
                `).bind(tenMillionHoursAgo).run();

                let whereClause = "";
                const params = [];
                
                // Search by league if leagueParam is provided
                if (leagueParam) {
                    whereClause = "WHERE league LIKE ? ";
                    params.push(`%${title}%`);
                }
                
                // Search by team name if query is provided
                if (query) {
                    if (whereClause) {
                        whereClause += " AND ";
                    } else {
                        whereClause = "WHERE ";
                    }
                    whereClause += "(home_team LIKE ? OR away_team LIKE ?)";
                    params.push(`%${query}%`, `%${query}%`);
                }
                
                if (!whereClause) {
                    whereClause = "WHERE league LIKE ?";
                    params.push(`%${title}%`);
                }

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
                    const keys = [
                        env.JUHE_API_KEY,
                        env.JUHE_API_KEY_2,
                        env.JUHE_API_KEY_3
                    ].filter(Boolean);
                    
                    let syncSuccess = false;
                    
                    for (const juheKey of keys) {
                        if (syncSuccess) break;
                        
                        try {
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 120 * 1000);
                            
                            const response = await fetch(`http://apis.juhe.cn/fapig/football/query?key=${juheKey}&type=${type}`, {
                                signal: controller.signal
                            });
                            clearTimeout(timeoutId);
                            
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
                                syncSuccess = true;
                                // Re-query after sync
                                const { results: retryResults } = await env.DB.prepare(sql).bind(...queryParams).all();
                                results = retryResults;

                                // Re-fetch total if needed
                                const { results: retryCountResults } = await env.DB.prepare(countSql).bind(...params).all();
                                total = retryCountResults[0].total;
                            } else if (data.error_code === 10012) {
                                console.log(`API key quota exceeded, trying next key...`);
                            }
                        } catch (e) {
                            console.error(`Live sync error:`, e);
                        }
                    }
                }

                const matchesWithSupplementedScores = await Promise.all(
                    results.map(async (r) => {
                        let score = r.score;
                        
                        if (score && (score === '- -' || score === '- - -' || !score.includes('-'))) {
                            const supplementedScore = await getRenjiuScore(env, r.home_team, r.away_team, r.match_time);
                            if (supplementedScore) {
                                console.log(`Supplemented score for ${r.home_team} vs ${r.away_team}: ${supplementedScore}`);
                                score = supplementedScore;
                            }
                        }
                        
                        return {
                            id: r.id,
                            match_id: r.match_id || null,
                            has_football_info: r.football_info ? true : false,
                            home: r.home_team,
                            away: r.away_team,
                            home_logo: r.home_logo,
                            away_logo: r.away_logo,
                            league: r.league,
                            date: r.match_time,
                            score: score,
                            status: r.status,
                            odds: r.odds ? JSON.parse(r.odds) : null,
                            match_type_des: r.match_type_des || null,
                            match_type_name: r.match_type_name || null
                        };
                    })
                );

                return new Response(JSON.stringify({
                    metadata: {
                        total,
                        page,
                        pageSize,
                        totalPages: Math.ceil(total / pageSize)
                    },
                    leagues: [],
                    players: [],
                    matches: matchesWithSupplementedScores
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

        if (url.pathname === '/api/renjiu/periods') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                const { results } = await env.DB.prepare("SELECT * FROM renjiu_periods ORDER BY period DESC").all();
                return new Response(JSON.stringify({ periods: results }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Renjiu periods query error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/renjiu/sync') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                console.log('Manual sync triggered for all data...');
                await syncJuheMatches(env);
                await syncRenjiuMatches(env);
                await supplementScoresFromLive500(env);
                return new Response(JSON.stringify({ message: 'Sync and supplement completed successfully' }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Sync error:', e);
                return new Response(JSON.stringify({ error: 'Sync failed', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/firo/bd') {
            try {
                const timestamp = Date.now().toString();
                console.log('Using timestamp:', timestamp);
                const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY);
                const headers = {
                    'X-API-Key': env.FIRO_API_KEY,
                    'X-Timestamp': timestamp,
                    'X-Signature': signature
                };
                
                console.log('Calling Firo BD API with signature:', signature.substring(0, 30) + '...');
                const response = await fetch('https://www.firoapi.com/firo/bd/issue-detail', { headers });
                console.log('Firo response status:', response.status);
                const text = await response.text();
                
                return new Response(text, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Firo API error:', e);
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/firo/jc') {
            try {
                const timestamp = Date.now().toString();
                const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY);
                const headers = {
                    'X-API-Key': env.FIRO_API_KEY,
                    'X-Timestamp': timestamp,
                    'X-Signature': signature
                };
                
                const queryString = url.search || '';
                const apiUrl = 'https://www.firoapi.com/firo/sports-lottery/list' + queryString;
                console.log('Calling JC API:', apiUrl);
                const response = await fetch(apiUrl, { headers });
                const text = await response.text();
                
                return new Response(text, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/firo/text/match-results') {
            try {
                const startDate = url.searchParams.get('startDate') || '';
                const endDate = url.searchParams.get('endDate') || '';
                const timestamp = Date.now().toString();
                const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY);
                const headers = {
                    'X-API-Key': env.FIRO_API_KEY,
                    'X-Timestamp': timestamp,
                    'X-Signature': signature
                };
                
                const params = [];
                if (startDate) params.push(`startDate=${startDate}`);
                if (endDate) params.push(`endDate=${endDate}`);
                const apiUrl = 'https://www.firoapi.com/firo/text/match-results' + (params.length > 0 ? '?' + params.join('&') : '');
                const response = await fetch(apiUrl, { headers });
                const text = await response.text();
                
                return new Response(text, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/firo/jc/all') {
            try {
                const dateParam = url.searchParams.get('date') || '';
                const timestamp = Date.now().toString();
                const params = dateParam ? { date: dateParam } : null;
                const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY, params);
                const headers = {
                    'X-API-Key': env.FIRO_API_KEY,
                    'X-Timestamp': timestamp,
                    'X-Signature': signature
                };
                
                const apiUrl = 'https://www.firoapi.com/firo/sports-lottery/all-list' + (dateParam ? '?date=' + dateParam : '');
                const response = await fetch(apiUrl, { headers });
                let text = await response.text();
                
                if (response.status === 401 && dateParam) {
                    const listResponse = await fetch('https://www.firoapi.com/firo/sports-lottery/list', { headers });
                    const listData = await listResponse.json();
                    if (listData.code === 200 && listData.data) {
                        const filtered = listData.data.filter(m => {
                            const mm = m.matchMain || m;
                            return mm.matchDate === dateParam || mm.matchStartDate === dateParam;
                        });
                        listData.data = filtered;
                        listData._filtered = true;
                        text = JSON.stringify(listData);
                    }
                }
                
                return new Response(text, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/firo/match-results/sync') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                console.log('Manual sync triggered for JC match-results...');
                await syncFiroMatchResults(env);
                return new Response(JSON.stringify({ message: 'JC match-results sync completed' }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Match-results sync error:', e);
                return new Response(JSON.stringify({ error: 'Match-results sync failed', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/firo/football-info') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            try {
                const matchId = url.searchParams.get('matchId') || '';
                const timestamp = Date.now().toString();
                const signature = await generateFiroSignature(env.FIRO_PRIVATE_KEY, timestamp, env.FIRO_API_KEY, { matchId });
                const headers = {
                    'X-API-Key': env.FIRO_API_KEY,
                    'X-Timestamp': timestamp,
                    'X-Signature': signature
                };
                const apiUrl = `https://www.firoapi.com/firo/sports-lottery/football-info?matchId=${matchId}`;
                const response = await fetch(apiUrl, { headers });
                const text = await response.text();
                return new Response(text, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // 从数据库读取 football-info（不调用 Firo API）
        if (url.pathname === '/api/football-info/db') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            try {
                const matchId = url.searchParams.get('matchId') || '';
                const source = (url.searchParams.get('source') || 'juhe').toLowerCase();
                if (!matchId) {
                    return new Response(JSON.stringify({ error: 'matchId is required' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const sourceMap = {
                    juhe: { table: 'juhe_matches', idCol: 'id' },
                    jc:   { table: 'lottery_jc_matches', idCol: 'match_id' },
                    bd:   { table: 'lottery_bd_matches', idCol: 'match_id' }
                };
                const sources = source === 'all'
                    ? ['juhe', 'jc', 'bd']
                    : [source];
                const invalid = sources.filter(s => !sourceMap[s]);
                if (invalid.length) {
                    return new Response(JSON.stringify({ error: `Invalid source: ${invalid.join(',')} (allowed: juhe, jc, bd, all)` }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const results = {};
                for (const s of sources) {
                    const { table, idCol } = sourceMap[s];
                    const stmt = env.DB.prepare(
                        `SELECT * FROM ${table} WHERE ${idCol} = ? LIMIT 1`
                    ).bind(matchId);
                    const row = await stmt.first();
                    if (row) {
                        let info = null;
                        try {
                            info = row.football_info ? JSON.parse(row.football_info) : null;
                        } catch (e) {
                            info = row.football_info;
                        }
                        results[s] = {
                            found: true,
                            match_id: row.match_id,
                            home_team: row.home_team || row.home || null,
                            away_team: row.away_team || row.away || null,
                            match_date: row.match_date || row.date || null,
                            league: row.league || null,
                            football_info: info
                        };
                    } else {
                        results[s] = { found: false, match_id: matchId };
                    }
                }

                return new Response(JSON.stringify({
                    code: 200,
                    matchId,
                    source,
                    data: source === 'all' ? results : results[source]
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // 世界杯资讯列表（公开访问，含 x-api-secret 鉴权）
        if (url.pathname === '/api/worldcup/news') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            try {
                const page = parseInt(url.searchParams.get('page') || '1');
                const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '20'), 50);
                const offset = (page - 1) * pageSize;

                const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM worldcup_news`).first();
                const total = countResult.total;
                const { results } = await env.DB.prepare(
                    `SELECT id, title, img, publish_time, news_source, content, created_at
                     FROM worldcup_news
                     ORDER BY publish_time DESC, id DESC
                     LIMIT ? OFFSET ?`
                ).bind(pageSize, offset).all();

                // ✅ juhe 详情接口为 worldcup2026/newsinfo（全小写）+ id 参数
                // 这里动态生成 search_url 让前端跳转到百度搜索原文
                const enriched = results.map(n => ({
                    ...n,
                    search_url: `https://www.baidu.com/s?wd=${encodeURIComponent((n.title || '') + ' ' + (n.news_source || ''))}`
                }));

                return new Response(JSON.stringify({
                    code: 200,
                    metadata: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
                    data: enriched
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // 手动触发世界杯资讯同步
        if (url.pathname === '/api/worldcup/news/sync') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            try {
                // 直接调 syncWorldcupNews（不受偶数小时限制）
                await syncWorldcupNews(env);
                const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM worldcup_news`).first();
                return new Response(JSON.stringify({
                    message: 'World Cup news sync completed',
                    total: countResult.total
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/lottery/sync') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                console.log('Manual sync triggered for lottery data...');
                await syncFiroLottery(env);
                return new Response(JSON.stringify({ message: 'Lottery sync completed successfully' }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Lottery sync error:', e);
                return new Response(JSON.stringify({ error: 'Lottery sync failed', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/juhe/sync') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                console.log('Manual sync triggered for Juhe matches...');
                // 手动触发时跳过 news 同步，避免与 /api/worldcup/news/sync 重复
                await syncJuheMatches(env, { skipNews: true });
                return new Response(JSON.stringify({ message: 'Juhe sync completed successfully' }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Juhe sync error:', e);
                return new Response(JSON.stringify({ error: 'Juhe sync failed', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/juhe/odds/sync') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            try {
                console.log('Manual sync triggered for odds from Firo...');
                await syncOddsFromFiro(env);
                return new Response(JSON.stringify({ message: 'Odds sync completed' }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Odds sync error:', e);
                return new Response(JSON.stringify({ error: 'Odds sync failed', details: e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // ===== Vercel AI SDK agent：M3 多步 tool_use =====
        if (url.pathname === '/api/ai/jc/agent' && request.method === 'POST') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            try {
                const startMs = Date.now();
                const result = await syncJcMatchesViaM3Agent(env);
                const elapsed = Date.now() - startMs;
                return new Response(JSON.stringify({
                    message: 'M3 agent JC list sync done',
                    elapsed_ms: elapsed,
                    result
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message, stack: e.stack?.substring(0, 500) }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/debug/schema') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
            }
            try {
                const tables = ['juhe_matches', 'lottery_jc_matches', 'lottery_bd_matches'];
                const result = {};
                for (const t of tables) {
                    const info = await env.DB.prepare(`PRAGMA table_info(${t})`).all();
                    result[t] = info.results;
                }
                return new Response(JSON.stringify(result, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500 });
            }
        }

        if (url.pathname.startsWith('/api/renjiu/matches/')) {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const period = url.pathname.split('/').pop();
            try {
                const { results } = await env.DB.prepare("SELECT * FROM renjiu_matches WHERE period = ? ORDER BY match_index ASC").bind(period).all();
                return new Response(JSON.stringify({ period, matches: results }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Renjiu matches query error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/renjiu/latest') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                const { results: periods } = await env.DB.prepare("SELECT period FROM renjiu_periods ORDER BY CAST(period AS INTEGER) DESC LIMIT 1").all();
                if (periods.length === 0) {
                    return new Response(JSON.stringify({ error: 'No data found' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const latestPeriod = periods[0].period;
                const { results: matches } = await env.DB.prepare("SELECT * FROM renjiu_matches WHERE period = ? ORDER BY match_index ASC").bind(latestPeriod).all();

                return new Response(JSON.stringify({ period: latestPeriod, matches }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Renjiu latest query error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        if (url.pathname === '/api/lottery') {
            const secret = request.headers.get('x-api-secret');
            if (secret !== env.API_SECRET) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            const type = url.searchParams.get('type') || 'JC';
            const page = parseInt(url.searchParams.get('page') || '1');
            const pageSize = parseInt(url.searchParams.get('pageSize') || '20');

            try {
                const tableName = type === 'BD' ? 'lottery_bd_matches' : 'lottery_jc_matches';
                const offset = (page - 1) * pageSize;
                // JC 比赛过滤掉"世界杯"系列（这些比赛已在 juhe_matches 中）
                const leagueFilter = type === 'JC' ? " WHERE league != '世界杯' AND league NOT LIKE '世界杯%' " : '';

                const { results: countResults } = await env.DB.prepare(`SELECT COUNT(*) as total FROM ${tableName}${leagueFilter}`).all();
                const total = countResults[0].total;

                const { results: matches } = await env.DB.prepare(
                    `SELECT * FROM ${tableName}${leagueFilter} ORDER BY match_time DESC LIMIT ? OFFSET ?`
                ).bind(pageSize, offset).all();

                return new Response(JSON.stringify({
                    metadata: {
                        total,
                        page,
                        pageSize,
                        totalPages: Math.ceil(total / pageSize)
                    },
                    matches: matches.map(m => ({
                        id: m.id,
                        match_id: m.match_id || null,
                        has_football_info: m.football_info ? true : false,
                        home: m.home_team,
                        away: m.away_team,
                        home_logo: m.home_logo,
                        away_logo: m.away_logo,
                        league: m.league,
                        league_country: m.league,
                        date: m.match_time,
                        score: m.score || '- -',
                        status: m.status,
                        odds: m.odds ? JSON.parse(m.odds) : null
                    }))
                }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (e) {
                console.error('Lottery query error:', e);
                return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
};

// Export functions for testing
export { fetchRenjiuPeriods, fetchRenjiuPeriodMatches, syncRenjiuMatches };
