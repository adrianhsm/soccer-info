import { HTML_TEMPLATE } from './ui.js';
import { SOCCER_DATA } from './data.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // API Endpoint
        if (url.pathname === '/api/search') {
            const query = url.searchParams.get('q')?.toLowerCase() || '';

            let responseData = { ...SOCCER_DATA };

            if (query) {
                // Simple search filtering
                responseData.leagues = SOCCER_DATA.leagues.filter(l =>
                    l.name.toLowerCase().includes(query) || l.country.toLowerCase().includes(query)
                );
                responseData.players = SOCCER_DATA.players.filter(p =>
                    p.name.toLowerCase().includes(query) || p.team.toLowerCase().includes(query)
                );
                responseData.matches = SOCCER_DATA.matches.filter(m =>
                    m.home.toLowerCase().includes(query) || m.away.toLowerCase().includes(query)
                );
            }

            return new Response(JSON.stringify(responseData), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*' // Allow easy testing
                }
            });
        }

        // Frontend Endpoint (Root)
        if (url.pathname === '/') {
            return new Response(HTML_TEMPLATE, {
                headers: {
                    'Content-Type': 'text/html;charset=UTF-8'
                }
            });
        }

        return new Response('Not Found', { status: 404 });
    },
};
