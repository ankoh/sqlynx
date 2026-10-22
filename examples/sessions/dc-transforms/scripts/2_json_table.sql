/*
  We want to support the following json_table in BDT:
JSON_TABLE(
    payload__c,
    '$' COLUMNS (
        NESTED PATH '$.orders[*]' COLUMNS (
            order_id TEXT PATH '$.order_id',
            NESTED PATH '$.items[*]' COLUMNS (
                item_id TEXT PATH '$.item_id',
                price NUMBER PATH '$.price'
            ))))
  This can be evaluated entirely without jsonpath as:
*/
with source (payload__c) as (
    values
        (
            '{"tag": "test-order-1",
        "orders": [
          { "order_id": "ORD-1001", "items": [
              {"item_id": "ITEM-101", "price": 19.99},
              {"item_id": "ITEM-102", "price": 7.50}
            ] },
          { "order_id": "ORD-1002", "items": [ {"item_id": "ITEM-201", "price": 125.00} ] } ]}'
        ),
        (
            '{"tag": "test-order-2",
        "orders": [
          { "order_id": "ORD-2001",
            "items": [ {"item_id": "ITEM-301", "price": 42.25} ] } ]}'
        )
)
select payload_json ->> 'tag' as tag,
    order_json ->> 'order_id' as order_id,
    item_json ->> 'item_id' as item_id,
    (item_json ->> 'price')::numeric as price
from source s
    cross join (select s.payload__c::json as payload_json) parsed
    cross join json_array_elements(payload_json -> 'orders') orders(
        order_json
    )
    cross join json_array_elements(order_json -> 'items') items(item_json);
