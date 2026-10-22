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
WITH source(payload__c) AS (
  VALUES
    ( '{"tag": "test-order-1",
        "orders": [
          { "order_id": "ORD-1001", "items": [
              {"item_id": "ITEM-101", "price": 19.99},
              {"item_id": "ITEM-102", "price": 7.50}
            ] },
          { "order_id": "ORD-1002", "items": [ {"item_id": "ITEM-201", "price": 125.00} ] } ]}'
    ),
    ( '{"tag": "test-order-2",
        "orders": [
          { "order_id": "ORD-2001",
            "items": [ {"item_id": "ITEM-301", "price": 42.25} ] } ]}'
    ))
SELECT
    payload_json ->> 'tag' AS tag,
    order_json   ->> 'order_id' AS order_id,
    item_json    ->> 'item_id' AS item_id,
    (item_json   ->> 'price')::numeric AS price
FROM source AS s
CROSS JOIN ( SELECT s.payload__c::json AS payload_json ) AS parsed
CROSS JOIN json_array_elements(payload_json -> 'orders') AS orders(order_json)
CROSS JOIN json_array_elements(order_json -> 'items') AS items(item_json);
