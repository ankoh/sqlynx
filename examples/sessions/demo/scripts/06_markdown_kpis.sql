WITH metrics(metric, value, status, detail) AS (
  VALUES
    ('Gross revenue', '$1.24M', 'On track', '12.8% above plan'),
    ('Open pipeline', '$842K', 'Watch', '18 opportunities still in review'),
    ('Renewal rate', '94.6%', 'Healthy', 'Up 2.1 points from last quarter')
)
SELECT metric, value, status, detail
FROM metrics
VISUALIZE USING markdown (
  template => '### {{metric}}

**{{value}}** · {{status}}

{{detail}}'
);
