export const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Soccer Info Hub</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-color: #10b981; /* Emerald 500 */
            --accent-hover: #34d399; /* Emerald 400 */
            --glass-border: rgba(255, 255, 255, 0.1);
        }

        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), 
                radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), 
                radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
            color: var(--text-primary);
            margin: 0;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 2rem;
            box-sizing: border-box;
        }

        h1 {
            font-size: 3rem;
            font-weight: 800;
            text-align: center;
            margin-bottom: 0.5rem;
            background: linear-gradient(to right, #4ade80, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 0 30px rgba(74, 222, 128, 0.3);
        }

        p.subtitle {
            color: var(--text-secondary);
            font-size: 1.1rem;
            margin-bottom: 3rem;
            text-align: center;
        }

        .search-container {
            width: 100%;
            max-width: 600px;
            position: relative;
            margin-bottom: 3rem;
        }

        input[type="text"] {
            width: 100%;
            padding: 1.25rem 1.5rem;
            font-size: 1.1rem;
            color: var(--text-primary);
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--glass-border);
            border-radius: 1rem;
            backdrop-filter: blur(10px);
            transition: all 0.3s ease;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            outline: none;
        }

        input[type="text"]:focus {
            border-color: var(--accent-color);
            box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.1);
            background: rgba(255, 255, 255, 0.1);
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            width: 100%;
            max-width: 1200px;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--glass-border);
            border-radius: 1.5rem;
            padding: 2rem;
            backdrop-filter: blur(10px);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            cursor: default;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.1);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .card h2 {
            font-size: 1.5rem;
            margin-top: 0;
            margin-bottom: 1rem;
            color: var(--accent-color);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .list-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 0.95rem;
        }

        .list-item:last-child {
            border-bottom: none;
        }

        .list-item span.label {
            color: var(--text-secondary);
        }

        .list-item span.value {
            font-weight: 600;
        }
        
        button#fetch-btn {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            background: var(--accent-color);
            color: white;
            border: none;
            padding: 0.6rem 1.2rem;
            border-radius: 0.75rem;
            cursor: pointer;
            font-weight: 600;
            transition: background 0.3s ease;
        }

        button#fetch-btn:hover {
            background: var(--accent-hover);
        }

        /* Loading Animation */
        .loader {
            border: 3px solid rgba(255,255,255,0.1);
            border-radius: 50%;
            border-top: 3px solid var(--accent-color);
            width: 20px;
            height: 20px;
            animation: spin 1s linear infinite;
            display: none;
            margin: 0 auto;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .hidden {
            display: none;
        }

        @media (max-width: 600px) {
            h1 { font-size: 2rem; }
            .grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>

    <h1>Soccer Hub</h1>
    <p class="subtitle">Global Football Statistics & Live Data</p>

    <div class="search-container">
        <input type="text" id="searchInput" placeholder="Search leagues, teams, or players...">
        <button id="fetch-btn">Search</button>
    </div>

    <div class="loader" id="loader"></div>

    <div class="grid" id="results">
        <!-- Default Content -->
        <div class="card">
            <h2>🏆 Featured Leagues</h2>
            <div id="leagues-list">
                <!-- Populated by JS -->
            </div>
        </div>

        <div class="card">
            <h2>⭐ Top Scorers</h2>
            <div id="players-list">
                 <!-- Populated by JS -->
            </div>
        </div>
        
         <div class="card">
            <h2>📅 Upcoming Matches</h2>
            <div id="matches-list">
                 <!-- Populated by JS -->
            </div>
        </div>
    </div>

    <script>
        // Start by fetching data
        document.addEventListener('DOMContentLoaded', () => {
             fetchData();
        });

        const searchInput = document.getElementById('searchInput');
        const fetchBtn = document.getElementById('fetch-btn');
        const loader = document.getElementById('loader');
        const resultsContainer = document.getElementById('results');

        fetchBtn.addEventListener('click', () => fetchData(searchInput.value));
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') fetchData(searchInput.value);
        });

        async function fetchData(query = '') {
            loader.style.display = 'block';
            resultsContainer.style.opacity = '0.5';

            try {
                const url = query ? \`/api/search?q=\${encodeURIComponent(query)}\` : '/api/search';
                const response = await fetch(url);
                const data = await response.json();
                
                render(data);
            } catch (err) {
                console.error('Error fetching data:', err);
                // In a real app, show visible error
            } finally {
                loader.style.display = 'none';
                resultsContainer.style.opacity = '1';
            }
        }

        function render(data) {
            // Render Leagues
            const leaguesContainer = document.getElementById('leagues-list');
            if (data.leagues && data.leagues.length > 0) {
                 leaguesContainer.innerHTML = data.leagues.map(l => \`
                    <div class="list-item">
                        <span class="value">\${l.name}</span>
                        <span class="label">\${l.country}</span>
                    </div>
                \`).join('');
            } else if (data.leagues) {
                 leaguesContainer.innerHTML = '<div class="list-item"><span class="label">No leagues found</span></div>';
            }


            // Render Players
            const playersContainer = document.getElementById('players-list');
            if (data.players && data.players.length > 0) {
                 playersContainer.innerHTML = data.players.map(p => \`
                    <div class="list-item">
                        <span class="value">\${p.name} (\${p.team})</span>
                        <span class="label">\${p.goals} Goals</span>
                    </div>
                \`).join('');
            } else if (data.players) {
                playersContainer.innerHTML = '<div class="list-item"><span class="label">No players found</span></div>';
            }
            
            // Render Matches
            const matchesContainer = document.getElementById('matches-list');
             if (data.matches && data.matches.length > 0) {
                 matchesContainer.innerHTML = data.matches.map(m => \`
                    <div class="list-item">
                        <span class="value">\${m.home} vs \${m.away}</span>
                        <span class="label">\${m.date}</span>
                    </div>
                \`).join('');
            } else if (data.matches) {
                matchesContainer.innerHTML = '<div class="list-item"><span class="label">No matches found</span></div>';
            }
        }
    </script>
</body>
</html>
`;
