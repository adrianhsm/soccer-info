async function testLive500Fetch() {
    console.log('Testing live.500.com fetch...\n');
    
    try {
        const response = await fetch('https://live.500.com/wanchang.php');
        if (!response.ok) {
            console.log('Response not OK:', response.status);
            return;
        }
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('gbk');
        const html = decoder.decode(buffer);
        
        console.log('HTML length:', html.length);
        
        const matches = [];
        
        const trRegex = /<tr[^>]*gy=["']([^"']*)["'][^>]*>([\s\S]*?)<\/tr>/g;
        let trMatch;
        let matchCount = 0;
        
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
                    matchCount++;
                    
                    if (homeTeam.includes('布伦特福德') || awayTeam.includes('富勒姆')) {
                        console.log('Found target match:');
                        console.log('  Home:', homeTeam);
                        console.log('  Away:', awayTeam);
                        console.log('  Score:', score);
                    }
                }
            }
        }
        
        console.log(`\nTotal matches found: ${matches.length}`);
        console.log(`Total tr elements checked: ${matchCount}`);
        
        const brentfordMatch = matches.find(m => m.home.includes('布伦特福德') || m.away.includes('富勒姆'));
        if (brentfordMatch) {
            console.log('\nBrentford vs Fulham match in results:');
            console.log(brentfordMatch);
        } else {
            console.log('\nBrentford vs Fulham match NOT in results');
        }
        
    } catch (e) {
        console.error('Error:', e);
    }
}

testLive500Fetch();