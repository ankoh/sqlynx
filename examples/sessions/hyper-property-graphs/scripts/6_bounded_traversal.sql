-- Bounded quantifiers repeat one edge label. This homogeneous graph connects nations that share a region, which makes one- and two-hop paths easy to
-- inspect.
with tpch as property graph (
    vertex tables (
        nation
            key (n_nationkey)
            label Nation properties (n_nationkey as nation_key, n_name as nation_name)
    )
    edge tables (
        (
                select source.n_nationkey as source_nation_key, destination.n_nationkey as destination_nation_key
                from nation source
                    join nation destination using (n_regionkey)
                where source.n_nationkey <> destination.n_nationkey
            ) as neighboring_nation
            key (source_nation_key, destination_nation_key)
            source key (source_nation_key) references nation
            destination key (destination_nation_key) references nation
            label SharesRegion no properties
    )
)
select source_nation, destination_nation
from graph_table(
    tpch
        match (source :Nation where source.nation_name = 'GERMANY')-[:SharesRegion]->{1,2}(destination :Nation)
        columns (source.nation_name as source_nation, destination.nation_name as destination_nation)
) paths
order by destination_nation;