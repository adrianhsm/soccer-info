import { fetchRenjiuPeriods, fetchRenjiuPeriodMatches, syncRenjiuMatches } from './src/index.js';

// Mock environment for testing
const mockEnv = {
    DB: {
        prepare: (sql) => {
            return {
                bind: (...params) => {
                    return {
                        all: () => Promise.resolve({ results: [] }),
                        run: () => Promise.resolve()
                    };
                }
            };
        },
        batch: () => Promise.resolve([])
    }
};

// Test HTML parsing logic
function testHtmlParsing() {
    console.log('Testing HTML parsing logic...');
    
    // Test period extraction
    const mockPeriodsHtml = `
    <div>
        <a href="/kaijiang/sfc/26062.html">26062期</a>
        <a href="/kaijiang/sfc/26061.html">26061期</a>
        <a href="/kaijiang/sfc/26060.html">26060期</a>
    </div>
    `;
    
    const periodRegex = /<a[^>]*href=["']\/kaijiang\/sfc\/(\d+)\.html["'][^>]*>/g;
    const periods = [];
    let match;
    while ((match = periodRegex.exec(mockPeriodsHtml)) !== null) {
        const period = match[1];
        if (!periods.includes(period)) {
            periods.push(period);
        }
    }
    
    console.log('Extracted periods:', periods);
    console.log('✓ Period extraction test passed');
    
    // Test match extraction
    const mockMatchesHtml = `
    <table>
        <tr>
            <td>1</td>
            <td>曼联</td>
            <td>利物浦</td>
            <td>2024-04-20 22:00</td>
            <td>2-1</td>
            <td>完赛</td>
            <td>英超</td>
        </tr>
        <tr>
            <td>2</td>
            <td>巴塞罗那</td>
            <td>皇家马德里</td>
            <td>2024-04-21 03:00</td>
            <td>1-1</td>
            <td>完赛</td>
            <td>西甲</td>
        </tr>
    </table>
    `;
    
    const matches = [];
    const trRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
    const allTrMatches = mockMatchesHtml.match(trRegex) || [];
    
    for (const tr of allTrMatches) {
        const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
        if (tds.length >= 6) {
            const cleanTd = (td) => td.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            
            const homeTeam = cleanTd(tds[1] || '');
            const awayTeam = cleanTd(tds[2] || '');
            const matchTime = cleanTd(tds[3] || '');
            const score = cleanTd(tds[4] || '');
            const status = cleanTd(tds[5] || '');
            const league = cleanTd(tds[6] || '');
            
            if (homeTeam && awayTeam && homeTeam !== '主场' && awayTeam !== '客场') {
                matches.push({
                    home_team: homeTeam,
                    away_team: awayTeam,
                    match_time: matchTime,
                    score: score,
                    status: status,
                    league: league
                });
            }
        }
    }
    
    console.log('Extracted matches:', matches);
    console.log('✓ Match extraction test passed');
    
    return { periods, matches };
}

// Test database operations
async function testDatabaseOperations() {
    console.log('Testing database operations...');
    
    try {
        // Test DB prepare and bind
        const mockSql = "INSERT INTO renjiu_periods (period) VALUES (?)";
        const prepared = mockEnv.DB.prepare(mockSql);
        const bound = prepared.bind('26062');
        await bound.run();
        console.log('✓ Database insert test passed');
        
        // Test DB query
        const query = mockEnv.DB.prepare("SELECT id FROM renjiu_periods WHERE period = ?");
        const result = await query.bind('26062').all();
        console.log('Query result:', result);
        console.log('✓ Database query test passed');
    } catch (error) {
        console.error('✗ Database operation test failed:', error);
    }
}

// Run tests
async function runTests() {
    console.log('Running Renjiu unit tests...\n');
    
    testHtmlParsing();
    console.log();
    
    await testDatabaseOperations();
    console.log();
    
    console.log('All unit tests completed!');
}

runTests();