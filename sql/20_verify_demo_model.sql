set pagesize 200
set linesize 200
set feedback on

prompt Verify the current connected service schema.

select user as connected_schema from dual;

select table_name, num_rows
  from user_tables
 order by table_name;

select object_type, status, count(*) as object_count
  from user_objects
 group by object_type, status
 order by object_type, status;
