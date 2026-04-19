const fetchLive500Matches = async () => {
    try {
        const response = await fetch('https://live.500.com/wanchang.php');
        if (!response.ok) return [];
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('gbk');
        const html = decoder.decode(buffer);
        
        const matches = [];
        
        const matchRegex = /<td[^>]*class=["'][^"']*bifen[^"']*["'][^>]*>.*?<a[^>]*>([^<]*)<\/a>.*?vs.*?<a[^>]*>([^<]*)<\/a>.*?<td[^>]*class=["'][^"']*bf[^"']*["'][^>]*>.*?<span[^>]*>([^<]*)<\/span>/g;
        let match;
        
        while ((match = matchRegex.exec(html)) !== null) {
            const homeTeam = match[1].trim();
            const awayTeam = match[2].trim();
            const score = match[3].trim();
            
            if (homeTeam && awayTeam && score && score.includes('-')) {
                matches.push({
                    home: homeTeam,
                    away: awayTeam,
                    score: score
                });
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

export { fetchLive500Matches, supplementScoresFromLive500 };
