async function testConnection() {
    console.log('Testing connection to 500.com...\n');
    
    try {
        console.log('1. Testing period list page (lskj):');
        const response = await fetch('https://www.500.com/kaijiang/sfc/lskj/');
        console.log('Status:', response.status);
        console.log('Status Text:', response.statusText);
        
        const html = await response.text();
        console.log('Response length:', html.length, 'characters');
        console.log('First 2000 chars of response:');
        console.log(html.substring(0, 2000));
        
        console.log('\n\n2. Testing specific period page (26062):');
        const response2 = await fetch('https://www.500.com/kaijiang/sfc/26062.html');
        console.log('Status:', response2.status);
        
        const html2 = await response2.text();
        console.log('Response length:', html2.length, 'characters');
        console.log('First 3000 chars of response:');
        console.log(html2.substring(0, 3000));
        
    } catch (error) {
        console.error('Error:', error);
        console.error('Error code:', error.code);
        console.error('Error message:', error.message);
        console.error('Error cause:', error.cause);
    }
}

testConnection();