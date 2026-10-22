SELECT * FROM external('https://data.dashql.app/vega-cars/v1/cars.parquet', format => 'parquet')
VISUALIZE USING vegalite (
  mark => point,
  encoding => (
    x => (field => "Year", type => temporal),
    y => (field => "Weight_in_lbs", type => quantitative),
    color => (field => "Origin")
  )
);