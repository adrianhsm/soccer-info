export const SOCCER_DATA = {
  leagues: [
    {
      id: "pl",
      name: "Premier League",
      country: "England",
      topTeams: ["Manchester City", "Arsenal", "Liverpool"],
      currentSeason: "2023-2024"
    },
    {
      id: "laliga",
      name: "La Liga",
      country: "Spain",
      topTeams: ["Real Madrid", "Barcelona", "Atletico Madrid"],
      currentSeason: "2023-2024"
    },
    {
      id: "bundesliga",
      name: "Bundesliga",
      country: "Germany",
      topTeams: ["Bayer Leverkusen", "Bayern Munich", "VfB Stuttgart"],
      currentSeason: "2023-2024"
    },
    {
      id: "seriea",
      name: "Serie A",
      country: "Italy",
      topTeams: ["Inter Milan", "AC Milan", "Juventus"],
      currentSeason: "2023-2024"
    }
  ],
  players: [
    {
      id: 1,
      name: "Erling Haaland",
      team: "Manchester City",
      position: "Forward",
      goals: 25
    },
    {
      id: 2,
      name: "Jude Bellingham",
      team: "Real Madrid",
      position: "Midfielder",
      goals: 19
    },
    {
      id: 3,
      name: "Harry Kane",
      team: "Bayern Munich",
      position: "Forward",
      goals: 36
    },
     {
      id: 4,
      name: "Kylian Mbappé",
      team: "Real Madrid", // Anticipating next season or just general star
      position: "Forward",
      goals: 27
    }
  ],
  matches: [
      {
          home: "Manchester City",
          away: "Arsenal",
          date: "2024-03-31",
          time: "16:30",
          stadium: "Etihad Stadium"
      },
       {
          home: "Real Madrid",
          away: "Barcelona",
          date: "2024-04-21",
          time: "20:00",
          stadium: "Santiago Bernabéu"
      }
  ]
};
