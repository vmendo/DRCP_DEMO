set echo on
set feedback on
set serveroutput on
set verify off
set pagesize 200
set linesize 200
whenever sqlerror exit sql.sqlcode

spool ../logs/schema_bootstrap_sqlcl.log replace

prompt === DRCP schema bootstrap started ===
prompt Connected as:
show user

@@01_create_service_schemas.sql
@@02_verify_service_schemas.sql

prompt === DRCP schema bootstrap completed ===
spool off
exit
