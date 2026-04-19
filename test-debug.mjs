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

async function debug() {
    const html = await fetch('https://www.500.com/kaijiang/sfc/26062.html');
    
    const teamnameTopRegex = /<div class="teamname teamname-top"[^>]*>[\s\S]*?<\/div>\s*<div class="vs"[^>]*>[\s\S]*?<\/div>\s*<div class="teamname"[^>]*>[\s\S]*?<\/div>/g;
    const teamMatches = html.match(teamnameTopRegex) || [];
    
    console.log(`Found ${teamMatches.length} team blocks\n`);
    
    if (teamMatches.length > 0) {
        const firstBlock = teamMatches[0];
        console.log('First team block:');
        console.log(firstBlock);
        console.log('\n' + '='.repeat(80) + '\n');
        
        const homeMatch = firstBlock.match(/<div class="teamname teamname-top"[^>]*>([\s\S]*?)<\/div>/);
        console.log('Home match:', homeMatch ? 'Found' : 'Not found');
        if (homeMatch) {
            console.log('Home content:', homeMatch[1]);
        }
        
        const awayMatch = firstBlock.match(/<div class="teamname"(?!.*teamname-top)[^>]*>([\s\S]*?)<\/div>/);
        console.log('Away match:', awayMatch ? 'Found' : 'Not found');
        if (awayMatch) {
            console.log('Away content:', awayMatch[1]);
        }
        
        const awayMatch2 = firstBlock.match(/<div class="teamname"[^>]*>([\s\S]*?)<\/div>\s*<\/td>/);
        console.log('Away match2:', awayMatch2 ? 'Found' : 'Not found');
        if (awayMatch2) {
            console.log('Away content2:', awayMatch2[1]);
        }
    }
}

debug();