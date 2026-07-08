set echo on
set feedback on
set serveroutput on
whenever sqlerror exit sql.sqlcode

prompt Creating Customers service model.

begin
  for t in (select table_name from user_tables where table_name in ('CUSTOMER_ACTIVITY','CUSTOMERS','CUSTOMER_SEGMENTS')) loop
    execute immediate 'drop table ' || t.table_name || ' cascade constraints purge';
  end loop;
end;
/

create table customer_segments (
  segment_id number primary key,
  segment_code varchar2(30) not null unique,
  segment_name varchar2(100) not null,
  service_tier varchar2(30) not null
);

create table customers (
  customer_id number primary key,
  segment_id number not null references customer_segments(segment_id),
  customer_name varchar2(120) not null,
  email varchar2(160) not null unique,
  city varchar2(80) not null,
  region_code varchar2(10) not null,
  loyalty_points number default 0 not null,
  status varchar2(20) default 'ACTIVE' not null
);

create table customer_activity (
  activity_id number primary key,
  customer_id number not null references customers(customer_id),
  activity_type varchar2(40) not null,
  activity_time timestamp not null,
  activity_detail varchar2(200)
);

create index ix_customers_segment on customers(segment_id);
create index ix_customer_activity_customer on customer_activity(customer_id, activity_time);

insert into customer_segments values (1, 'GOLD', 'Gold Loyalty', 'PRIORITY');
insert into customer_segments values (2, 'SILVER', 'Silver Loyalty', 'STANDARD');
insert into customer_segments values (3, 'BUSINESS', 'Small Business Buyer', 'PRIORITY');

insert into customers values (501, 1, 'Ava Turner', 'ava.turner@example.com', 'Seattle', 'US-W', 18420, 'ACTIVE');
insert into customers values (502, 2, 'Liam Brooks', 'liam.brooks@example.com', 'Portland', 'US-W', 7340, 'ACTIVE');
insert into customers values (503, 3, 'Maya Chen Coffee LLC', 'ops@mayachen.example.com', 'San Francisco', 'US-W', 28800, 'ACTIVE');
insert into customers values (504, 1, 'Noah Patel', 'noah.patel@example.com', 'Austin', 'US-C', 16610, 'ACTIVE');
insert into customers values (505, 2, 'Sofia Garcia', 'sofia.garcia@example.com', 'Chicago', 'US-C', 6200, 'ACTIVE');

insert into customer_activity values (9001, 501, 'SEARCH', systimestamp - interval '3' hour, 'Searched espresso beans and oat milk');
insert into customer_activity values (9002, 503, 'REORDER', systimestamp - interval '2' hour, 'Business reorder for coffee and sugar');
insert into customer_activity values (9003, 504, 'SUPPORT', systimestamp - interval '1' hour, 'Asked about order delivery window');
insert into customer_activity values (9004, 502, 'CART', systimestamp - interval '45' minute, 'Added sourdough loaf');
insert into customer_activity values (9005, 505, 'LOYALTY', systimestamp - interval '20' minute, 'Redeemed loyalty points');

commit;

prompt Customers service model complete.
