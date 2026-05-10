const crypto = require('crypto');
const fs = require('fs');

// 读取私钥文件或直接使用
const privateKeyPem = `-----BEGIN RSA PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCXYgjWM7W46/Eps
kcfNe1UNYQOtxh3PsZNqV/rbBDEn5VQ0ZYvs+zIiAbOZTNszHCPw3tIR74XeGase5oQ
Pq75l+/ZA1wbcv1/U7RC9FlV7dbh9oBQWl+detQeYGpP1A20GerfbH8lppag6E7sG/ir
oAEGzMcMtW4FdWOBsh11WVtjKWobK0C7uw/y5TQaQQcAuldKXW+5rzvVNDTmNFbH1v0b
2zZ+62pSLDwgEteBY0iW0nPbBxHAWVbciNN0BQSTn/WSMTtjth4w+3vu8iJ6rVDhn+D3
ESkHmdwmdIKm8FxHWD1AXfcpZ8jh/bIIjAjJ9r9hZjCRMC3Rv2UkKIIBAgMBAAECggEA
RKNjpFOv2pfIMgKucr1NzXeyV8W25yJkYYQhhKnr9GrzFcDh2uE2xDnA9EY4ieUsSFL
3C+/TherGiwBD+4egaHT2gCwg0CVUQS4ftpf6BZcgbjYJOeWwIsQ1d0x6B5X7XKS/tOw
JvnWJKI4Mcsu/9XlH3eBthBqjNwBhzMWIy9KyNCU0jFjFw28x8ZkKW8PZ2V8l6Tn7tCXu
zPUYwY3EQlldJ2j+ARqB+wStYJJYUg/Zw7ehWFv9JMLaojF/0L3lawo1+z2kN7FvV1zH
1s2yFLutMIiTPoAGOFxcHXBevdjMHoqb2ngelFQv2/WcWEfdY/TzIVl7sZ0cqYdop9LPE
QKBgQDoph6qhldPRu4kyKtkztWfQVlvZKJU9dbdAk2T+LuhuAbRLSGT5xgSFtJfdXnCr9
q9e3uVgRXZRg+zzK9pXLfFDY+TZNd/1Nv/DZlKZBVJEE28xjAwVlFCOL/t68PVAT6sm
5dWQwsNtY9s3/DHEtansdm8f2xnhDdFGQEZgcPN1QKBgQCmk8wwBZs+6d0ldzPbZo44
9xn97FS9V0VwYewedCpRwyH6HOa2+/+ZoAfrbAuqAzucgSrV+ju/Bee9QqBArQBmPagY
updK8jbAcSJuTNz/Kd1wNuu1FNHQoRUc3W06gOcTI4qSU9ipgb5Snb+erF/TJLkXeG0Hu
97lwKSRpdx9fQKBgBP2BNWOtzkHFfG0AfihQnTqj3jeQotVmHzX8L4MblTezD7wR1xAT
LFood4s3yiUHAl76cuXCr/cogZEPpykpuPSWQpFcbP3GHUWvptCYQ0mx/S1cHcFQO2Un
usT+nZxJ+Z5Zw+wqucfN9IYmLkL5bz3pn3k1PFAx9k23wBIQPuNAoGAfJ2s73ACR/qk
mlam0MfUNgGFzFR0wID9Tamz/sRgtHIKhRYB83pqKP9zbUeTIkjw25A1/4YIFEvSpd+m
CzxhRBt0Gavdaw/wrd71JxcRbUJgioZLp1g/7pfTN5jfEhlExSidjgJz37tUKnIg3A+Q
UGD0pv5McrC1e6O2ec9fN/ECgYEA1UhWvnk3FOSbB4sMf+P+dDQr/XYPS6ViCQJQUBb
SykvuxAPglI1+ohwZ+erWO+Yg2In+kmJmNg14Bp+m8Ym0pgOrW+cYsXgBqyccMbE33JUb
o7NuN0NsiMWTDurjvRNspuNCyV54oiYxISieSpaRdQ3OGeaniA77O//EvhGHMWc=
-----END RSA PRIVATE KEY-----`;

const apiKey = 'JDSiSnXpJ61pi162VEkjSFH80FgJtmAR';
const timestamp = Date.now().toString();

// Sign with RSA-SHA256
const sign = crypto.createSign('RSA-SHA256');
sign.update(timestamp);
sign.end();

const signature = sign.sign(privateKeyPem, 'base64');

console.log('Timestamp:', timestamp);
console.log('Signature:', signature);

console.log('\n=== Curl Command (竞彩) ===');
console.log(`curl -X GET "https://www.firoapi.com/firo/sports-lottery/list" \\`);
console.log(`  -H "X-API-Key: ${apiKey}" \\`);
console.log(`  -H "X-Timestamp: ${timestamp}" \\`);
console.log(`  -H "X-Signature: ${signature}"`);

console.log('\n=== Curl Command (北单) ===');
console.log(`curl -X GET "https://www.firoapi.com/firo/bd/issue-detail" \\`);
console.log(`  -H "X-API-Key: ${apiKey}" \\`);
console.log(`  -H "X-Timestamp: ${timestamp}" \\`);
console.log(`  -H "X-Signature: ${signature}"`);

console.log('\n=== Direct Test (竞彩) ===');
const https = require('https');

const jcOptions = {
  hostname: 'www.firoapi.com',
  path: '/firo/sports-lottery/list',
  method: 'GET',
  headers: {
    'X-API-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Signature': signature
  }
};

const req = https.request(jcOptions, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    const json = JSON.parse(data);
    console.log('Code:', json.code);
    console.log('Message:', json.message);
    if (json.data) {
      console.log('Data count:', json.data.length);
      if (json.data[0]) {
        console.log('First match:', JSON.stringify(json.data[0], null, 2));
      }
    }
  });
});
req.on('error', (e) => console.error('Error:', e.message));
req.end();