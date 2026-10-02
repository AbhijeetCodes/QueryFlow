// The practice database: a small made-up shop to learn SQL on, loaded as test
// tables (shop.customers, shop.products, shop.orders, shop.order_items), and
// example queries that run on it. Everything here is invented.

export const PRACTICE_TABLES = {
  'shop.customers': `customer_id,name,country,city,signup_date
1,Ana Lim,SG,Singapore,2023-01-15
2,Ben Tan,MY,Kuala Lumpur,2023-02-03
3,Chloe Ng,SG,Singapore,2023-02-20
4,Dev Patel,IN,Mumbai,2023-03-11
5,Eva Cruz,PH,Manila,2023-04-02
6,Farid Rahman,MY,Penang,2023-05-19
7,Grace Ho,SG,Singapore,2023-06-07
8,Hiro Sato,JP,Osaka,2023-07-23
9,Ivy Santos,PH,Cebu,2023-08-30
10,Jun Park,KR,Seoul,2023-10-12
11,Kim Le,VN,,2023-11-05
12,Leo Wong,SG,Singapore,2024-01-09
`,
  'shop.products': `product_id,name,category,price
1,Wireless Mouse,Electronics,25
2,Mechanical Keyboard,Electronics,89.9
3,USB-C Cable,Electronics,9.5
4,Desk Lamp,Home,34
5,Coffee Mug,Home,12
6,Throw Pillow,Home,18.5
7,Notebook,Stationery,4.2
8,Gel Pens 5-pack,Stationery,6.8
9,Backpack,Accessories,49
10,Water Bottle,Accessories,15
`,
  'shop.orders': `order_id,customer_id,order_date,status
1,1,2024-01-05,delivered
2,2,2024-01-09,delivered
3,1,2024-01-21,delivered
4,3,2024-02-02,cancelled
5,4,2024-02-10,delivered
6,5,2024-02-14,delivered
7,2,2024-02-28,returned
8,6,2024-03-03,delivered
9,7,2024-03-09,delivered
10,1,2024-03-15,delivered
11,8,2024-03-22,delivered
12,9,2024-04-01,cancelled
13,3,2024-04-06,delivered
14,10,2024-04-12,delivered
15,5,2024-04-20,delivered
16,11,2024-04-29,delivered
17,7,2024-05-04,returned
18,2,2024-05-11,delivered
19,4,2024-05-18,delivered
20,6,2024-05-25,shipped
21,1,2024-06-02,shipped
22,9,2024-06-08,delivered
23,10,2024-06-15,shipped
24,3,2024-06-21,shipped
`,
  'shop.order_items': `order_id,product_id,quantity,unit_price
1,3,3,9.5
1,7,2,4.2
2,9,1,49
3,1,2,25
3,10,1,15
4,2,2,89.9
5,2,1,89.9
5,4,2,34
6,1,1,25
6,2,3,89.9
7,1,1,25
7,7,2,4.2
7,10,2,15
8,5,2,12
9,9,1,49
10,3,1,9.5
10,5,2,12
10,9,2,49
11,6,1,18.5
12,1,2,25
12,2,3,89.9
12,4,2,34
13,6,2,18.5
13,8,3,6.8
14,4,1,34
14,5,3,10.8
15,2,2,89.9
16,8,3,6.8
16,9,3,49
17,2,1,89.9
17,5,2,12
18,3,1,9.5
18,6,2,18.5
19,1,2,25
19,2,2,89.9
20,6,2,18.5
20,10,2,15
21,2,1,89.9
21,8,3,6.8
21,9,3,49
22,1,3,25
23,8,3,6.8
23,10,3,15
24,1,2,25
24,6,1,18.5
`,
};

export const PRACTICE_NOTE = 'A made-up shop: 12 customers, 10 products, 24 orders and their 45 order items. Leo Wong has no orders yet, and Kim Le has no city.';

// From first steps to CTEs. Each one runs on the practice tables as written (BigQuery SQL).
export const PRACTICE_QUERIES = [
  {
    title: 'Look at a table',
    sql: `-- Practice: every row and column of one table.
SELECT *
FROM shop.customers;
`,
  },
  {
    title: 'Filter and sort',
    sql: `-- Practice: WHERE keeps some rows, ORDER BY sorts them.
SELECT
  name,
  city,
  signup_date
FROM shop.customers
WHERE country = 'SG'
ORDER BY signup_date;
`,
  },
  {
    title: 'Count per group',
    sql: `-- Practice: GROUP BY makes one row per status, COUNT(*) counts the orders in each.
SELECT
  status,
  COUNT(*) AS orders
FROM shop.orders
GROUP BY status
ORDER BY orders DESC;
`,
  },
  {
    title: 'Join tables',
    sql: `-- Practice: JOIN matches each order to its customer and its items.
-- Revenue per customer from orders that were not cancelled or returned.
SELECT
  c.name,
  COUNT(DISTINCT o.order_id) AS orders,
  ROUND(SUM(i.quantity * i.unit_price), 2) AS revenue
FROM shop.customers AS c
JOIN shop.orders AS o
  ON o.customer_id = c.customer_id
JOIN shop.order_items AS i
  ON i.order_id = o.order_id
WHERE o.status IN ('delivered', 'shipped')
GROUP BY c.name
ORDER BY revenue DESC;
`,
  },
  {
    title: 'Who never ordered (LEFT JOIN)',
    sql: `-- Practice: LEFT JOIN keeps every customer; those with no order get NULLs.
SELECT
  c.name,
  c.signup_date
FROM shop.customers AS c
LEFT JOIN shop.orders AS o
  ON o.customer_id = c.customer_id
WHERE o.order_id IS NULL;
`,
  },
  {
    title: 'Revenue per month',
    sql: `-- Practice: DATE_TRUNC rounds each date down to its month.
SELECT
  DATE_TRUNC(o.order_date, MONTH) AS month,
  ROUND(SUM(i.quantity * i.unit_price), 2) AS revenue
FROM shop.orders AS o
JOIN shop.order_items AS i
  ON i.order_id = o.order_id
WHERE o.status != 'cancelled'
GROUP BY month
ORDER BY month;
`,
  },
  {
    title: 'Best seller per category (CTEs)',
    sql: `-- Practice: CTEs name each step; ROW_NUMBER ranks rows within a category.
-- Open the Graph or Steps tab to see how the steps connect.
WITH sales AS (
  SELECT
    p.category,
    p.name,
    SUM(i.quantity) AS units
  FROM shop.order_items AS i
  JOIN shop.products AS p
    ON p.product_id = i.product_id
  GROUP BY p.category, p.name
),

ranked AS (
  SELECT
    category,
    name,
    units,
    ROW_NUMBER() OVER (PARTITION BY category ORDER BY units DESC, name) AS rank_in_category
  FROM sales
)

SELECT
  category,
  name,
  units
FROM ranked
WHERE rank_in_category = 1
ORDER BY category;
`,
  },
];
