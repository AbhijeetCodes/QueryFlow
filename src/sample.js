// The example: a short query per dialect on the practice Pokédex, so every feature has
// something to show (variables, filter values, a date window, joins, a dedupe and two
// lint warnings). The editor starts empty; main.js loads this module only when someone
// asks for the example.

export const SAMPLE_SQL = `-- Example: each trainer's strongest Pokémon
declare caught_since date default '2024-01-01';
declare min_level int64 default 20;

with team as (
  select trainer_id, pokemon_id, level from pokedex.teams
  where caught_on >= caught_since and level >= min_level
), stats as (
  select pokemon_id, name, type, hp + attack + defense + speed as total_stats from pokedex.pokemon
  where not is_legendary
), ranked as (
  select tr.name as trainer, s.name as pokemon, s.type, t.level, s.total_stats,
    row_number() over (partition by tr.trainer_id order by s.total_stats desc) as rank_in_team
  from team t
  join stats s on s.pokemon_id = t.pokemon_id
  join pokedex.trainers tr on tr.trainer_id = t.trainer_id
  where tr.region in ('Kanto', 'Johto')
), legendaries as (select * from pokedex.pokemon where is_legendary)
select trainer, pokemon, type, level, total_stats from ranked
where rank_in_team = 1
order by total_stats desc
`;

export const SAMPLE_POSTGRES = `-- Example: each trainer's strongest Pokémon
with params as (select date '2024-01-01' as caught_since, 20 as min_level
), team as (
  select t.trainer_id, t.pokemon_id, t.level from pokedex.teams t, params p
  where t.caught_on >= p.caught_since and t.level >= p.min_level
), stats as (
  select pokemon_id, name, type, hp + attack + defense + speed as total_stats from pokedex.pokemon
  where not is_legendary
), best as (
  select distinct on (tr.trainer_id) tr.name as trainer, s.name as pokemon, s.type, t.level, s.total_stats
  from team t
  join stats s on s.pokemon_id = t.pokemon_id
  join pokedex.trainers tr on tr.trainer_id = t.trainer_id
  where tr.region in ('Kanto', 'Johto')
  order by tr.trainer_id, s.total_stats desc
), legendaries as (select * from pokedex.pokemon where is_legendary)
select trainer, pokemon, type, level, total_stats from best
order by total_stats desc
`;

export const SAMPLE_MYSQL = `-- Example: each trainer's strongest Pokémon
set @caught_since = '2024-01-01';
set @min_level = 20;

with team as (
  select trainer_id, pokemon_id, level from pokedex.teams
  where caught_on >= @caught_since and level >= @min_level
), stats as (
  select pokemon_id, name, type, hp + attack + defense + speed as total_stats from pokedex.pokemon
  where not is_legendary
), ranked as (
  select tr.name as trainer, s.name as pokemon, s.type, t.level, s.total_stats,
    row_number() over (partition by tr.trainer_id order by s.total_stats desc) as rank_in_team
  from team t
  join stats s on s.pokemon_id = t.pokemon_id
  join pokedex.trainers tr on tr.trainer_id = t.trainer_id
  where tr.region in ('Kanto', 'Johto')
), legendaries as (select * from pokedex.pokemon where is_legendary)
select trainer, pokemon, type, level, total_stats from ranked
where rank_in_team = 1
order by total_stats desc
`;

export const SAMPLE_SQLSERVER = `-- Example: each trainer's strongest Pokémon
declare @caught_since date = '2024-01-01';
declare @min_level int = 20;

with team as (
  select trainer_id, pokemon_id, level from pokedex.teams
  where caught_on >= @caught_since and level >= @min_level
), stats as (
  select pokemon_id, name, type, hp + attack + defense + speed as total_stats from pokedex.pokemon
  where is_legendary = 0
), ranked as (
  select tr.name as trainer, s.name as pokemon, s.type, t.level, s.total_stats,
    row_number() over (partition by tr.trainer_id order by s.total_stats desc) as rank_in_team
  from team t
  join stats s on s.pokemon_id = t.pokemon_id
  join pokedex.trainers tr on tr.trainer_id = t.trainer_id
  where tr.region in ('Kanto', 'Johto')
), legendaries as (select * from pokedex.pokemon where is_legendary = 1)
select top 10 trainer, pokemon, type, level, total_stats from ranked
where rank_in_team = 1
order by total_stats desc
`;

export const SAMPLES = { bigquery: SAMPLE_SQL, postgres: SAMPLE_POSTGRES, mysql: SAMPLE_MYSQL, sqlserver: SAMPLE_SQLSERVER };

// The example reads the practice database (src/practice.js).
export { PRACTICE_TABLES as SAMPLE_TABLES } from './practice.js';
