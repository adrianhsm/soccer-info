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

async function extractPeriods(html) {
    const periods = [];
    const regex = /"(\d{5})","(\d{4}-\d{2}-\d{2})","([^"]+)"/g;
    let match;
    
    while ((match = regex.exec(html)) !== null) {
        const period = match[1];
        const date = match[2];
        const result = match[3];
        periods.push({ period, date, result });
    }
    
    return periods.slice(0, 10);
}

async function main() {
    console.log('Fetching renjiu periods from 500.com...\n');
    
    try {
        const html = await fetch('https://www.500.com/kaijiang/sfc/lskj/');
        const periods = await extractPeriods(html);
        
        console.log('Found periods:');
        console.log('='.repeat(80));
        
        for (const p of periods) {
            console.log(`期号: ${p.period}`);
            console.log(`日期: ${p.date}`);
            console.log(`开奖结果: ${p.result}`);
            console.log('-'.repeat(80));
        }
        
        console.log(`\nTotal: ${periods.length} periods shown`);
        
    } catch (error) {
        console.error('Error:', error);
    }
}

main();