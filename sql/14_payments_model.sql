set echo on
set feedback on
set serveroutput on
whenever sqlerror exit sql.sqlcode

prompt Creating Payments service model.

begin
  for t in (select table_name from user_tables where table_name in ('PAYMENT_EVENTS','PAYMENT_AUTHORIZATIONS','PAYMENT_METHODS')) loop
    execute immediate 'drop table ' || t.table_name || ' cascade constraints purge';
  end loop;
end;
/

create table payment_methods (
  payment_method_id number primary key,
  customer_id number not null,
  method_type varchar2(30) not null,
  token_suffix varchar2(8) not null,
  status varchar2(20) not null
);

create table payment_authorizations (
  authorization_id number primary key,
  order_id number not null,
  customer_id number not null,
  payment_method_id number not null references payment_methods(payment_method_id),
  amount number(10,2) not null,
  currency_code char(3) default 'USD' not null,
  auth_status varchar2(30) not null,
  authorized_at timestamp default systimestamp not null
);

create table payment_events (
  event_id number primary key,
  authorization_id number not null references payment_authorizations(authorization_id),
  event_type varchar2(40) not null,
  event_time timestamp default systimestamp not null,
  processor_message varchar2(200)
);

create index ix_payment_authorizations_order on payment_authorizations(order_id);
create index ix_payment_authorizations_customer on payment_authorizations(customer_id);

insert into payment_methods values (6001, 501, 'CARD', '1842', 'ACTIVE');
insert into payment_methods values (6002, 502, 'CARD', '7340', 'ACTIVE');
insert into payment_methods values (6003, 503, 'ACH', '0288', 'ACTIVE');
insert into payment_methods values (6004, 504, 'CARD', '6610', 'ACTIVE');
insert into payment_methods values (6005, 505, 'WALLET', '6200', 'ACTIVE');

insert into payment_authorizations values (6101, 8001, 501, 6001, 40.40, 'USD', 'CAPTURED', systimestamp - interval '29' minute);
insert into payment_authorizations values (6102, 8002, 503, 6003, 57.30, 'USD', 'AUTHORIZED', systimestamp - interval '23' minute);
insert into payment_authorizations values (6103, 8003, 504, 6004, 24.50, 'USD', 'CAPTURED', systimestamp - interval '17' minute);
insert into payment_authorizations values (6104, 8005, 505, 6005, 16.20, 'USD', 'AUTHORIZED', systimestamp - interval '5' minute);

insert into payment_events values (6201, 6101, 'AUTHORIZE', systimestamp - interval '29' minute, 'Approved by processor');
insert into payment_events values (6202, 6101, 'CAPTURE', systimestamp - interval '28' minute, 'Capture complete');
insert into payment_events values (6203, 6102, 'AUTHORIZE', systimestamp - interval '23' minute, 'ACH hold accepted');
insert into payment_events values (6204, 6103, 'AUTHORIZE', systimestamp - interval '17' minute, 'Approved by processor');
insert into payment_events values (6205, 6104, 'AUTHORIZE', systimestamp - interval '5' minute, 'Wallet authorization accepted');

commit;

prompt Payments service model complete.
