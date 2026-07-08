set echo on
set feedback on
set serveroutput on
whenever sqlerror exit sql.sqlcode

prompt Creating Orders service model.

begin
  for t in (select table_name from user_tables where table_name in ('ORDER_EVENTS','ORDER_LINES','ORDERS')) loop
    execute immediate 'drop table ' || t.table_name || ' cascade constraints purge';
  end loop;
end;
/

create table orders (
  order_id number primary key,
  order_number varchar2(30) not null unique,
  customer_id number not null,
  order_status varchar2(30) not null,
  order_total number(10,2) not null,
  order_time timestamp default systimestamp not null,
  fulfillment_region varchar2(10) not null
);

create table order_lines (
  order_line_id number primary key,
  order_id number not null references orders(order_id),
  product_id number not null,
  quantity number not null,
  unit_price number(10,2) not null,
  line_total number(10,2) not null
);

create table order_events (
  event_id number primary key,
  order_id number not null references orders(order_id),
  event_type varchar2(40) not null,
  event_time timestamp default systimestamp not null,
  event_note varchar2(200)
);

create index ix_orders_customer on orders(customer_id, order_time);
create index ix_order_lines_product on order_lines(product_id);

insert into orders values (8001, 'ORD-8001', 501, 'PAID', 40.40, systimestamp - interval '30' minute, 'US-W');
insert into orders values (8002, 'ORD-8002', 503, 'ALLOCATED', 57.30, systimestamp - interval '24' minute, 'US-W');
insert into orders values (8003, 'ORD-8003', 504, 'PAID', 24.50, systimestamp - interval '18' minute, 'US-C');
insert into orders values (8004, 'ORD-8004', 502, 'PICKING', 5.25, systimestamp - interval '12' minute, 'US-W');
insert into orders values (8005, 'ORD-8005', 505, 'AUTHORIZED', 16.20, systimestamp - interval '6' minute, 'US-C');

insert into order_lines values (8101, 8001, 1001, 2, 18.50, 37.00);
insert into order_lines values (8102, 8001, 1004, 1, 3.40, 3.40);
insert into order_lines values (8103, 8002, 1001, 2, 18.50, 37.00);
insert into order_lines values (8104, 8002, 1005, 4, 4.90, 19.60);
insert into order_lines values (8105, 8002, 1003, 1, 5.25, 5.25);
insert into order_lines values (8106, 8003, 1005, 5, 4.90, 24.50);
insert into order_lines values (8107, 8004, 1003, 1, 5.25, 5.25);
insert into order_lines values (8108, 8005, 1004, 3, 3.40, 10.20);
insert into order_lines values (8109, 8005, 1002, 1, 12.80, 12.80);

insert into order_events values (8201, 8001, 'CREATED', systimestamp - interval '30' minute, 'Order created by Gold customer Ava Turner');
insert into order_events values (8202, 8001, 'PAID', systimestamp - interval '29' minute, 'Payment authorization captured');
insert into order_events values (8203, 8002, 'ALLOCATED', systimestamp - interval '23' minute, 'Inventory allocated in Bay Area FC');
insert into order_events values (8204, 8004, 'PICKING', systimestamp - interval '10' minute, 'Bakery item released to pick station');
insert into order_events values (8205, 8005, 'AUTHORIZED', systimestamp - interval '5' minute, 'Waiting for final capture');

commit;

prompt Orders service model complete.
