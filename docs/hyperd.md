## Local development

Get yourself a hyperd from the Tableau Hyper API, then launch hyperd with:

```
hyperd run \
    --listen-connection tcp.grpc://localhost:7484 \
    --skip-license \
    --no-password \
    --init-user tableau_internal_user \
    --log_config=cerr,json,all

```
