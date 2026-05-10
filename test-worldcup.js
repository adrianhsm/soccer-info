const API_KEY = '09b351bedd9e04db624c5b03841d2e1a';

async function testWorldCup() {
    console.log('Testing World Cup API...\n');
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120 * 1000);
        
        const response = await fetch(`https://apis.juhe.cn/fapigw/worldcup2026/schedule?key=${API_KEY}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        const data = await response.json();
        
        console.log('API response structure:');
        console.log('- error_code:', data.error_code);
        console.log('- reason:', data.reason);
        console.log('- result keys:', data.result ? Object.keys(data.result) : 'null');
        
        if (data.error_code === 0 && data.result) {
            const matches = [];
            const scheduleList = data.result.data || [];
            
            console.log(`\nFound ${scheduleList.length} schedule groups`);
            
            scheduleList.forEach((dayGroup, idx) => {
                const dayMatches = dayGroup.schedule_list || [];
                console.log(`Group ${idx}: ${dayMatches.length} matches`);
                
                dayMatches.forEach(m => {
                    const status = m.match_status === '1' ? '未开赛' : 
                                   m.match_status === '2' ? '比赛中' : 
                                   m.match_status === '3' ? '完赛' : m.match_des || '未知';
                    
                    const matchDate = m.date_time ? m.date_time.replace(' ', 'T') + 'Z' : `${m.date}T00:00:00Z`;
                    
                    matches.push({
                        home: m.host_team_name,
                        away: m.guest_team_name,
                        league: `世界杯-${m.match_type_name || '小组赛'}`,
                        date: matchDate,
                        score: `${m.host_team_score || '-'}-${m.guest_team_score || '-'}`,
                        status: status
                    });
                });
            });
            
            console.log(`\nTotal matches prepared: ${matches.length}`);
            
            if (matches.length > 0) {
                console.log('\nFirst match sample:');
                console.log(JSON.stringify(matches[0], null, 2));
                
                console.log('\nLast match sample:');
                console.log(JSON.stringify(matches[matches.length - 1], null, 2));
            }
        } else {
            console.log(`\nAPI error: ${data.reason}`);
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

testWorldCup();