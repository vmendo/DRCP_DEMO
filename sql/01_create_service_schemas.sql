set echo on
set feedback on
set serveroutput on
set verify off

define drcp_schema_password = "replace_with_service_schema_password"

prompt Creating DRCP demo service schemas and minimal grants.
prompt Override the default password placeholder with:
prompt   sql -name ADMIN_CONNECTION @sql/01_create_service_schemas.sql drcp_schema_password=your_password

declare
  type user_list_t is table of varchar2(128);
  l_users user_list_t := user_list_t(
    'DRCP_CATALOG',
    'DRCP_INVENTORY',
    'DRCP_ORDERS',
    'DRCP_PAYMENTS',
    'DRCP_CUSTOMERS'
  );

  procedure exec_ddl(p_sql in varchar2) is
  begin
    dbms_output.put_line(p_sql);
    execute immediate p_sql;
  exception
    when others then
      dbms_output.put_line('FAILED: ' || sqlerrm);
      raise;
  end;
begin
  for i in 1 .. l_users.count loop
    declare
      l_count number;
    begin
      select count(*)
        into l_count
        from dba_users
       where username = l_users(i);

      if l_count = 0 then
        exec_ddl(
          'create user ' || l_users(i) ||
          ' identified by "&&drcp_schema_password" ' ||
          'default tablespace DATA temporary tablespace TEMP ' ||
          'quota unlimited on DATA'
        );
      else
        exec_ddl(
          'alter user ' || l_users(i) ||
          ' identified by "&&drcp_schema_password" account unlock ' ||
          'default tablespace DATA temporary tablespace TEMP ' ||
          'quota unlimited on DATA'
        );
      end if;

      exec_ddl('grant create session to ' || l_users(i));
      exec_ddl('grant create table to ' || l_users(i));
      exec_ddl('grant create view to ' || l_users(i));
      exec_ddl('grant create sequence to ' || l_users(i));
      exec_ddl('grant create procedure to ' || l_users(i));
    end;
  end loop;
end;
/

prompt DRCP demo service schema creation finished.
