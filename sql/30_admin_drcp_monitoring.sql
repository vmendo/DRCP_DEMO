set echo on
set feedback on
whenever sqlerror exit sql.sqlcode

prompt Optional admin-side DRCP monitoring check.
prompt Run with your ADMIN SQLcl connection when validating DRCP visibility.

select pool_name,
       num_open_servers,
       num_busy_servers,
       num_requests,
       num_hits,
       num_misses,
       num_waits
  from v$cpool_stats;

select cclass_name, num_requests, num_hits, num_misses
  from v$cpool_cc_stats
 order by cclass_name;
