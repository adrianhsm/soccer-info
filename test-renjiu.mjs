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

// Test fetchRenjiuPeriods
async function testFetchRenjiuPeriods() {
    console.log('Testing fetchRenjiuPeriods...');
    try {
        const periods = await fetchRenjiuPeriods();
        console.log(`Found ${periods.length} periods`);
        console.log('First 5 periods:', periods.slice(0, 5));
        console.log('✓ fetchRenjiuPeriods test passed');
        return periods;
    } catch (error) {
        console.error('✗ fetchRenjiuPeriods test failed:', error);
        return [];
    }
}

// Test fetchRenjiuPeriodMatches
async function testFetchRenjiuPeriodMatches(period) {
    if (!period) {
        console.log('✗ fetchRenjiuPeriodMatches test skipped - no period provided');
        return;
    }
    
    console.log(`Testing fetchRenjiuPeriodMatches for period ${period}...`);
    try {
        const matches = await fetchRenjiuPeriodMatches(mockEnv, period);
        console.log(`Found ${matches.length} matches for period ${period}`);
        if (matches.length > 0) {
            console.log('First 3 matches:', matches.slice(0, 3));
        }
        console.log('✓ fetchRenjiuPeriodMatches test passed');
    } catch (error) {
        console.error('✗ fetchRenjiuPeriodMatches test failed:', error);
    }
}

// Test syncRenjiuMatches
async function testSyncRenjiuMatches() {
    console.log('Testing syncRenjiuMatches...');
    try {
        await syncRenjiuMatches(mockEnv);
        console.log('✓ syncRenjiuMatches test passed');
    } catch (error) {
        console.error('✗ syncRenjiuMatches test failed:', error);
    }
}

// Run all tests
async function runTests() {
    console.log('Running Renjiu tests...\n');
    
    const periods = await testFetchRenjiuPeriods();
    console.log();
    
    if (periods.length > 0) {
        await testFetchRenjiuPeriodMatches(periods[0]);
        console.log();
    }
    
    await testSyncRenjiuMatches();
    console.log();
    
    console.log('All tests completed!');
}

runTests();