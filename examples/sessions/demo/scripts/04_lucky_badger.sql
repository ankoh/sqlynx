SELECT v AS x, random() AS y
FROM generate_series(1, 100) t(v)
VISUALIZE USING vegalite (
  mark => point,
  encoding => (
    x => (field => x, type => quantitative),
    y => (field => y, type => quantitative)
  )
);
