set pagesize 200
set linesize 220
set feedback on

prompt Live DRCP demo connection footprint by service schema.

column service_name format a14
column username format a18
column server format a12
column status format a12
column sessions format 999999

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
 order by service_name, server, status;

prompt DRCP pool statistics, when enabled and visible to the admin user.

select pool_name,
       num_open_servers,
       num_busy_servers,
       num_requests,
       num_hits,
       num_misses,
       num_waits
  from v$cpool_stats;

prompt DRCP connection-class statistics, when enabled and visible to the admin user.

select cclass_name,
       num_requests,
       num_hits,
       num_misses
  from v$cpool_cc_stats
 order by cclass_name;
