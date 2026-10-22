WITH customer_summary AS (
  SELECT
    c.c_name AS customer,
    n.n_name AS nation,
    count(o.o_orderkey) AS order_count,
    sum(o.o_totalprice) AS order_value,
    max(o.o_orderdate) AS latest_order
  FROM customer AS c
  JOIN orders AS o ON o.o_custkey = c.c_custkey
  JOIN nation AS n ON n.n_nationkey = c.c_nationkey
  GROUP BY c.c_name, n.n_name
  ORDER BY order_value DESC
  LIMIT 5
)
SELECT customer, nation, order_count, order_value, latest_order
FROM customer_summary
VISUALIZE USING markdown (
  template => '## {{customer}}

**Market:** {{nation}} · **Orders:** {{order_count}}

**Order value:** {{order_value}}

_Latest order: {{latest_order}}_'
);
