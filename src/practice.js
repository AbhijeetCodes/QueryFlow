// The practice database: a small made-up Pokédex to learn SQL on, loaded as test tables
// (pokedex.pokemon, pokedex.trainers, pokedex.teams), and example queries that run on it.
// The editor's example (src/sample.js) reads the same tables. Names and base stats are
// the games' own; the trainers' teams are invented.

// Some rows are there to be filtered out by the example: a low level, a catch before
// 2024, legendaries and a trainer from Hoenn. Eevee and Mew are in no one's team.
export const PRACTICE_TABLES = {
  'pokedex.pokemon': `pokemon_id,name,type,generation,is_legendary,hp,attack,defense,speed
1,Bulbasaur,Grass,1,false,45,49,49,45
6,Charizard,Fire,1,false,78,84,78,100
7,Squirtle,Water,1,false,44,48,65,43
25,Pikachu,Electric,1,false,35,55,40,90
94,Gengar,Ghost,1,false,60,65,60,110
131,Lapras,Water,1,false,130,85,80,60
133,Eevee,Normal,1,false,55,55,50,55
143,Snorlax,Normal,1,false,160,110,65,30
149,Dragonite,Dragon,1,false,91,134,95,80
150,Mewtwo,Psychic,1,true,106,110,90,130
151,Mew,Psychic,1,true,100,100,100,100
152,Chikorita,Grass,2,false,45,49,65,45
158,Totodile,Water,2,false,50,65,64,43
248,Tyranitar,Rock,2,false,100,134,110,61
249,Lugia,Psychic,2,true,106,90,130,110
`,
  'pokedex.trainers': `trainer_id,name,region
1,Ash,Kanto
2,Misty,Kanto
3,Brock,Kanto
4,Lyra,Johto
5,May,Hoenn
`,
  'pokedex.teams': `trainer_id,pokemon_id,level,caught_on
1,25,42,2024-01-03
1,6,48,2024-02-11
1,1,18,2024-03-05
1,150,70,2024-04-01
2,7,30,2024-01-20
2,131,45,2024-05-02
3,143,40,2023-11-30
3,94,36,2024-02-14
4,158,25,2024-03-18
4,248,55,2024-06-09
4,152,12,2024-04-22
5,149,60,2024-02-02
5,249,70,2024-05-30
`,
};

export const PRACTICE_NOTE = 'A made-up Pokédex: 15 Pokémon, 5 trainers and the 13 Pokémon on their teams. Eevee and Mew are on no one\'s team yet.';

// From first steps to CTEs. Each one runs on the practice tables as written (BigQuery SQL).
export const PRACTICE_QUERIES = [
  {
    title: 'Look at a table',
    sql: `-- Practice: every row and column of one table.
SELECT *
FROM pokedex.pokemon;
`,
  },
  {
    title: 'Filter and sort',
    sql: `-- Practice: WHERE keeps some rows, ORDER BY sorts them.
-- The fastest Pokémon of generation 1.
SELECT
  name,
  type,
  speed
FROM pokedex.pokemon
WHERE generation = 1
ORDER BY speed DESC, name;
`,
  },
  {
    title: 'Count per group',
    sql: `-- Practice: GROUP BY makes one row per type, COUNT(*) counts the Pokémon of each.
SELECT
  type,
  COUNT(*) AS pokemon
FROM pokedex.pokemon
GROUP BY type
ORDER BY pokemon DESC, type;
`,
  },
  {
    title: 'Join tables',
    sql: `-- Practice: JOIN matches each team member to its trainer and its Pokémon.
-- Team size, highest level and total base stats per trainer.
SELECT
  tr.name AS trainer,
  COUNT(*) AS team_size,
  MAX(t.level) AS top_level,
  SUM(p.hp + p.attack + p.defense + p.speed) AS team_stats
FROM pokedex.teams AS t
JOIN pokedex.trainers AS tr
  ON tr.trainer_id = t.trainer_id
JOIN pokedex.pokemon AS p
  ON p.pokemon_id = t.pokemon_id
GROUP BY tr.name
ORDER BY team_stats DESC;
`,
  },
  {
    title: 'Not on any team (LEFT JOIN)',
    sql: `-- Practice: LEFT JOIN keeps every Pokémon; those on no team get NULLs.
SELECT
  p.name,
  p.type
FROM pokedex.pokemon AS p
LEFT JOIN pokedex.teams AS t
  ON t.pokemon_id = p.pokemon_id
WHERE t.trainer_id IS NULL;
`,
  },
  {
    title: 'Catches per month',
    sql: `-- Practice: DATE_TRUNC rounds each date down to its month.
SELECT
  DATE_TRUNC(caught_on, MONTH) AS month,
  COUNT(*) AS catches
FROM pokedex.teams
GROUP BY month
ORDER BY month;
`,
  },
  {
    title: 'Strongest of each type (CTEs)',
    sql: `-- Practice: CTEs name each step; ROW_NUMBER ranks rows within a type.
-- Open the Graph or Steps tab to see how the steps connect.
WITH stats AS (
  SELECT
    name,
    type,
    hp + attack + defense + speed AS total_stats
  FROM pokedex.pokemon
),

ranked AS (
  SELECT
    type,
    name,
    total_stats,
    ROW_NUMBER() OVER (PARTITION BY type ORDER BY total_stats DESC, name) AS rank_in_type
  FROM stats
)

SELECT
  type,
  name,
  total_stats
FROM ranked
WHERE rank_in_type = 1
ORDER BY total_stats DESC;
`,
  },
];
