set echo on
set feedback on
set serveroutput on
whenever sqlerror exit sql.sqlcode

prompt Creating Inventory service model.

begin
  for t in (select table_name from user_tables where table_name in ('STOCK_MOVEMENTS','STOCK_LEVELS','WAREHOUSES')) loop
    execute immediate 'drop table ' || t.table_name || ' cascade constraints purge';
  end loop;
end;
/

create table warehouses (
  warehouse_id number primary key,
  warehouse_code varchar2(20) not null unique,
  warehouse_name varchar2(100) not null,
  city varchar2(80) not null,
  region_code varchar2(10) not null
);

create table stock_levels (
  warehouse_id number not null references warehouses(warehouse_id),
  product_id number not null,
  on_hand_qty number not null,
  reserved_qty number not null,
  reorder_point number not null,
  last_counted_at timestamp default systimestamp not null,
  constraint pk_stock_levels primary key (warehouse_id, product_id)
);

create table stock_movements (
  movement_id number primary key,
  warehouse_id number not null references warehouses(warehouse_id),
  product_id number not null,
  movement_type varchar2(30) not null,
  quantity number not null,
  reference_id varchar2(40),
  movement_time timestamp default systimestamp not null
);

create index ix_stock_levels_product on stock_levels(product_id);
create index ix_stock_movements_product on stock_movements(product_id, movement_time);

insert into warehouses values (301, 'SEA-FC1', 'Seattle Fulfillment Center', 'Seattle', 'US-W');
insert into warehouses values (302, 'SFO-FC1', 'Bay Area Fulfillment Center', 'San Francisco', 'US-W');
insert into warehouses values (303, 'AUS-FC1', 'Austin Fulfillment Center', 'Austin', 'US-C');

insert into stock_levels values (301, 1001, 420, 63, 120, systimestamp);
insert into stock_levels values (301, 1002, 310, 40, 100, systimestamp);
insert into stock_levels values (301, 1003, 85, 28, 40, systimestamp);
insert into stock_levels values (302, 1001, 260, 80, 90, systimestamp);
insert into stock_levels values (302, 1004, 620, 95, 160, systimestamp);
insert into stock_levels values (303, 1005, 510, 70, 150, systimestamp);
insert into stock_levels values (303, 1003, 74, 16, 35, systimestamp);

insert into stock_movements values (7001, 301, 1001, 'RESERVE', -2, 'ORD-8001', systimestamp - interval '30' minute);
insert into stock_movements values (7002, 302, 1004, 'RESERVE', -6, 'ORD-8002', systimestamp - interval '24' minute);
insert into stock_movements values (7003, 303, 1005, 'RESERVE', -4, 'ORD-8003', systimestamp - interval '18' minute);
insert into stock_movements values (7004, 301, 1003, 'PICK', -1, 'ORD-8004', systimestamp - interval '12' minute);
insert into stock_movements values (7005, 302, 1001, 'RECEIVE', 120, 'ASN-4491', systimestamp - interval '8' minute);

commit;

prompt Inventory service model complete.
