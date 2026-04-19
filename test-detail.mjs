import https from 'https';

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchRenjiuPeriodMatches(period) {
    try {
        const response = await fetch(`https://www.500.com/kaijiang/sfc/${period}.html`);
        const html = response;
        
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
}

async function main() {
    console.log('Fetching match details for period 26062...\n');
    
    const matches = await fetchRenjiuPeriodMatches('26062');
    
    console.log('\nMatches found:');
    console.log('='.repeat(80));
    
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        console.log(`Match ${i + 1}:`);
        console.log(`  Home: ${m.home_team}`);
        console.log(`  Away: ${m.away_team}`);
        console.log(`  Score: ${m.score}`);
        console.log(`  Status: ${m.status}`);
        console.log('-'.repeat(80));
    }
    
    console.log(`\nTotal: ${matches.length} matches`);
}

main();