import { fetchRenjiuPeriods, fetchRenjiuPeriodMatches, syncRenjiuMatches } from './src/index.js';

// Mock fetch for testing
global.fetch = jest.fn();

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

// Test HTML responses
const mockPeriodsHtml = `
<div>
    <a href="/kaijiang/sfc/26062.html">26062期</a>
    <a href="/kaijiang/sfc/26061.html">26061期</a>
    <a href="/kaijiang/sfc/26060.html">26060期</a>
</div>
`;

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

describe('Renjiu Functions', () => {
    beforeEach(() => {
        global.fetch.mockClear();
    });

    test('fetchRenjiuPeriods should extract periods from HTML', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => mockPeriodsHtml
        });

        const periods = await fetchRenjiuPeriods();
        expect(periods).toEqual(['26062', '26061', '26060']);
    });

    test('fetchRenjiuPeriodMatches should extract matches from HTML', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => mockMatchesHtml
        });

        const matches = await fetchRenjiuPeriodMatches(mockEnv, '26062');
        expect(matches).toHaveLength(2);
        expect(matches[0]).toEqual({
            home_team: '曼联',
            away_team: '利物浦',
            match_time: '2024-04-20 22:00',
            score: '2-1',
            status: '完赛',
            league: '英超'
        });
        expect(matches[1]).toEqual({
            home_team: '巴塞罗那',
            away_team: '皇家马德里',
            match_time: '2024-04-21 03:00',
            score: '1-1',
            status: '完赛',
            league: '西甲'
        });
    });

    test('syncRenjiuMatches should handle empty periods', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => '<div></div>'
        });

        await expect(syncRenjiuMatches(mockEnv)).resolves.not.toThrow();
    });
});