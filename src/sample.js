// Demo query loaded on first visit (deliberately messy — Format cleans it up).
export const SAMPLE_SQL = `-- Seller cohort performance by category (sample query — paste your own!)
declare start_date date default '2024-01-01';
declare end_date date default '2024-03-31';
declare min_orders int64 default 3;

with sellers as (
  select u.user_id, u.country, u.signup_date from \`analytics-prod.core.users\` u
  where u.country in ('SG','MY','PH') and u.is_seller = true
), listings as (
  select l.listing_id, l.seller_id, l.category_id, l.created_at from \`analytics-prod.marketplace.listings\` l
  where date(l.created_at) between start_date and end_date and l.status != 'deleted'
), orders as (
  select o.order_id, o.listing_id, o.buyer_id, o.gmv_usd, o.created_at from \`analytics-prod.marketplace.orders\` o
  where date(o.created_at) between '2024-01-01' and '2024-03-31' and o.state = 'completed'
  order by o.created_at
), seller_orders as (
  select s.user_id, s.country, c.category_name, count(distinct o.order_id) orders, sum(o.gmv_usd) gmv
  from sellers s
  join listings l on l.seller_id = s.user_id
  left join orders o on o.listing_id = l.listing_id
  left join \`analytics-prod.core.categories\` c on c.category_id = l.category_id
  group by 1,2,3
), old_cohort as (select * from sellers where signup_date < '2020-01-01')
select so.country, so.category_name, count(*) sellers, sum(so.gmv) gmv, avg(so.orders) avg_orders
from seller_orders so
where so.orders >= min_orders and so.gmv > 100 and so.country = @country
  and so.user_id not in (select user_id from \`analytics-prod.trust.banned_users\` where banned_at >= timestamp_sub(current_timestamp(), interval 90 day))
group by 1, 2
order by gmv desc
`;
