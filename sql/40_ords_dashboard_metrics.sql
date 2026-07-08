set define off
set serveroutput on

prompt Creating ORDS dashboard metrics endpoints for the DRCP demo.
prompt Run as ADMIN.

begin
  ords.enable_schema(
    p_enabled             => true,
    p_schema              => 'ADMIN',
    p_url_mapping_type    => 'BASE_PATH',
    p_url_mapping_pattern => 'admin',
    p_auto_rest_auth      => false
  );
  commit;
end;
/

begin
  ords.delete_module(p_module_name => 'drcp_dashboard_metrics');
exception
  when others then
    null;
end;
/

begin
  ords.define_module(
    p_module_name    => 'drcp_dashboard_metrics',
    p_base_path      => 'drcp-demo/dashboard/',
    p_items_per_page => 100,
    p_status         => 'PUBLISHED',
    p_comments       => 'DRCP demo dashboard metrics. Read-only Oracle evidence endpoints.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'pool-metrics',
    p_comments    => 'Aggregated dashboard metrics JSON from Oracle monitoring views.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'pool-metrics',
    p_method      => 'GET',
    p_source_type => ords.source_type_plsql,
    p_source      => q'[
declare
  l_json clob;
begin
  select json_object(
           'sessionFootprint' value coalesce((
             select json_arrayagg(
                      json_object(
                        'service_name' value service_name,
                        'username' value username,
                        'server' value server,
                        'status' value status,
                        'sessions' value sessions
                        returning clob
                      )
                      returning clob
                    )
               from (
                 select case username
                          when 'DRCP_CATALOG' then 'catalog'
                          when 'DRCP_INVENTORY' then 'inventory'
                          when 'DRCP_ORDERS' then 'orders'
                          when 'DRCP_PAYMENTS' then 'payments'
                          when 'DRCP_CUSTOMERS' then 'customers'
                          else lower(username)
                        end as service_name,
                        username,
                        server,
                        status,
                        count(*) as sessions
                   from v$session
                  where username in (
                        'DRCP_CATALOG',
                        'DRCP_INVENTORY',
                        'DRCP_ORDERS',
                        'DRCP_PAYMENTS',
                        'DRCP_CUSTOMERS'
                  )
                  group by username, server, status
                  order by service_name, server, status
               )
           ), json_array(returning clob)),
           'cpoolStats' value coalesce((
             select json_arrayagg(
                      json_object(
                        'pool_name' value pool_name,
                        'num_open_servers' value num_open_servers,
                        'num_busy_servers' value num_busy_servers,
                        'num_requests' value num_requests,
                        'num_hits' value num_hits,
                        'num_misses' value num_misses,
                        'num_waits' value num_waits
                        returning clob
                      )
                      returning clob
                    )
               from v$cpool_stats
           ), json_array(returning clob)),
           'cpoolClasses' value coalesce((
             select json_arrayagg(
                      json_object(
                        'cclass_name' value cclass_name,
                        'num_requests' value num_requests,
                        'num_hits' value num_hits,
                        'num_misses' value num_misses
                        returning clob
                      )
                      returning clob
                    )
               from v$cpool_cc_stats
           ), json_array(returning clob)),
           'cpoolConnections' value coalesce((
             select json_arrayagg(
                      json_object(
                        'pool_name' value pool_name,
                        'username' value username,
                        'cclass_name' value cclass_name,
                        'purity' value purity,
                        'tag' value tag,
                        'connection_status' value connection_status,
                        'connection_mode' value connection_mode,
                        'numgets' value numgets
                        returning clob
                      )
                      returning clob
                    )
               from (
                 select pool_name,
                        username,
                        cclass_name,
                        purity,
                        tag,
                        connection_status,
                        connection_mode,
                        numgets
                   from v$cpool_conn_info
                  where rownum <= 20
                  order by username, cclass_name, connection_status
               )
           ), json_array(returning clob)),
           'cpoolClassInfo' value coalesce((
             select json_arrayagg(
                      json_object(
                        'pool_name' value pool_name,
                        'cclass_name' value cclass_name
                        returning clob
                      )
                      returning clob
                    )
               from (
                 select pool_name,
                        cclass_name
                   from v$cpool_cc_info
                  where rownum <= 20
                  order by cclass_name
               )
           ), json_array(returning clob)),
           'resourceLimit' value coalesce((
             select json_arrayagg(
                      json_object(
                        'resource_name' value resource_name,
                        'current_utilization' value current_utilization,
                        'max_utilization' value max_utilization,
                        'initial_allocation' value initial_allocation,
                        'limit_value' value limit_value
                        returning clob
                      )
                      returning clob
                    )
               from v$resource_limit
              where resource_name = 'sessions'
           ), json_array(returning clob))
           returning clob
         )
    into l_json
    from dual;

  owa_util.mime_header('application/json', false);
  htp.p('Cache-Control: no-store');
  owa_util.http_header_close;
  htp.prn(l_json);
end;
]',
    p_comments    => 'Sources: V$SESSION, V$CPOOL_STATS, V$CPOOL_CC_STATS, V$CPOOL_CONN_INFO, V$CPOOL_CC_INFO, V$RESOURCE_LIMIT.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'session-footprint',
    p_comments    => 'V$SESSION service footprint for DRCP demo schemas.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'session-footprint',
    p_method      => 'GET',
    p_source_type => ords.source_type_collection_feed,
    p_source      => q'[
select case username
         when 'DRCP_CATALOG' then 'catalog'
         when 'DRCP_INVENTORY' then 'inventory'
         when 'DRCP_ORDERS' then 'orders'
         when 'DRCP_PAYMENTS' then 'payments'
         when 'DRCP_CUSTOMERS' then 'customers'
         else lower(username)
       end as service_name,
       username,
       server,
       status,
       count(*) as sessions
  from v$session
 where username in (
       'DRCP_CATALOG',
       'DRCP_INVENTORY',
       'DRCP_ORDERS',
       'DRCP_PAYMENTS',
       'DRCP_CUSTOMERS'
 )
 group by username, server, status
 order by service_name, server, status
]',
    p_comments    => 'Source: V$SESSION.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-stats',
    p_comments    => 'V$CPOOL_STATS aggregate DRCP pool counters.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-stats',
    p_method      => 'GET',
    p_source_type => ords.source_type_collection_feed,
    p_source      => q'[
select pool_name,
       num_open_servers,
       num_busy_servers,
       num_requests,
       num_hits,
       num_misses,
       num_waits
  from v$cpool_stats
]',
    p_comments    => 'Source: V$CPOOL_STATS.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-cc-stats',
    p_comments    => 'V$CPOOL_CC_STATS connection-class counters.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-cc-stats',
    p_method      => 'GET',
    p_source_type => ords.source_type_collection_feed,
    p_source      => q'[
select cclass_name,
       num_requests,
       num_hits,
       num_misses
  from v$cpool_cc_stats
 order by cclass_name
]',
    p_comments    => 'Source: V$CPOOL_CC_STATS.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-conn-info',
    p_comments    => 'V$CPOOL_CONN_INFO current DRCP connection information.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-conn-info',
    p_method      => 'GET',
    p_source_type => ords.source_type_collection_feed,
    p_source      => q'[
select pool_name,
       username,
       cclass_name,
       purity,
       tag,
       connection_status,
       connection_mode,
       numgets
  from v$cpool_conn_info
 where rownum <= 20
 order by username, cclass_name, connection_status
]',
    p_comments    => 'Source: V$CPOOL_CONN_INFO.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-cc-info',
    p_comments    => 'V$CPOOL_CC_INFO configured DRCP connection classes.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'cpool-cc-info',
    p_method      => 'GET',
    p_source_type => ords.source_type_collection_feed,
    p_source      => q'[
select pool_name,
       cclass_name
  from v$cpool_cc_info
 where rownum <= 20
 order by cclass_name
]',
    p_comments    => 'Source: V$CPOOL_CC_INFO.'
  );

  ords.define_template(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'resource-limit',
    p_comments    => 'V$RESOURCE_LIMIT session limit and utilization.'
  );
  ords.define_handler(
    p_module_name => 'drcp_dashboard_metrics',
    p_pattern     => 'resource-limit',
    p_method      => 'GET',
    p_source_type => ords.source_type_collection_feed,
    p_source      => q'[
select resource_name,
       current_utilization,
       max_utilization,
       initial_allocation,
       limit_value
  from v$resource_limit
 where resource_name = 'sessions'
]',
    p_comments    => 'Source: V$RESOURCE_LIMIT.'
  );

  commit;
end;
/

prompt ORDS endpoints:
prompt   /ords/admin/drcp-demo/dashboard/pool-metrics
prompt   /ords/admin/drcp-demo/dashboard/session-footprint
prompt   /ords/admin/drcp-demo/dashboard/cpool-stats
prompt   /ords/admin/drcp-demo/dashboard/cpool-cc-stats
prompt   /ords/admin/drcp-demo/dashboard/cpool-conn-info
prompt   /ords/admin/drcp-demo/dashboard/cpool-cc-info
prompt   /ords/admin/drcp-demo/dashboard/resource-limit
