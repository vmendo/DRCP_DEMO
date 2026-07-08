set echo on
set feedback on
set pagesize 200
set linesize 200

prompt Verifying DRCP demo service schemas.

column username format a24
column account_status format a24
column default_tablespace format a24
column temporary_tablespace format a24

select username,
       account_status,
       default_tablespace,
       temporary_tablespace
  from dba_users
 where username in (
       'DRCP_CATALOG',
       'DRCP_INVENTORY',
       'DRCP_ORDERS',
       'DRCP_PAYMENTS',
       'DRCP_CUSTOMERS'
 )
 order by username;

column grantee format a24
column privilege format a24

select grantee,
       privilege
  from dba_sys_privs
 where grantee in (
       'DRCP_CATALOG',
       'DRCP_INVENTORY',
       'DRCP_ORDERS',
       'DRCP_PAYMENTS',
       'DRCP_CUSTOMERS'
 )
   and privilege in (
       'CREATE SESSION',
       'CREATE TABLE',
       'CREATE VIEW',
       'CREATE SEQUENCE',
       'CREATE PROCEDURE'
 )
 order by grantee, privilege;
