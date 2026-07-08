set echo on
set feedback on
set serveroutput on
whenever sqlerror exit sql.sqlcode

prompt Creating Catalog service model.

begin
  for t in (select table_name from user_tables where table_name in ('PRICE_HISTORY','PRODUCTS','PRODUCT_CATEGORIES')) loop
    execute immediate 'drop table ' || t.table_name || ' cascade constraints purge';
  end loop;
end;
/

create table product_categories (
  category_id number primary key,
  category_code varchar2(30) not null unique,
  category_name varchar2(100) not null
);

create table products (
  product_id number primary key,
  sku varchar2(30) not null unique,
  category_id number not null references product_categories(category_id),
  product_name varchar2(120) not null,
  brand varchar2(80) not null,
  base_price number(10,2) not null,
  status varchar2(20) default 'ACTIVE' not null,
  created_at timestamp default systimestamp not null
);

create table price_history (
  price_id number primary key,
  product_id number not null references products(product_id),
  effective_from date not null,
  effective_to date,
  price number(10,2) not null,
  price_reason varchar2(80) not null
);

create index ix_products_category on products(category_id);
create index ix_price_history_product on price_history(product_id, effective_from);

insert into product_categories values (10, 'COFFEE', 'Coffee and Brewing');
insert into product_categories values (20, 'BAKERY', 'Bakery');
insert into product_categories values (30, 'PANTRY', 'Pantry Essentials');

insert into products values (1001, 'SKU-COF-001', 10, 'Redwood Espresso Beans 1kg', 'Northstar Roasters', 18.50, 'ACTIVE', systimestamp);
insert into products values (1002, 'SKU-COF-002', 10, 'Colombia Filter Roast 500g', 'Northstar Roasters', 12.80, 'ACTIVE', systimestamp);
insert into products values (1003, 'SKU-BAK-001', 20, 'Sourdough Country Loaf', 'Oak Street Bakery', 5.25, 'ACTIVE', systimestamp);
insert into products values (1004, 'SKU-PAN-001', 30, 'Organic Oat Milk 1L', 'Green Valley', 3.40, 'ACTIVE', systimestamp);
insert into products values (1005, 'SKU-PAN-002', 30, 'Raw Cane Sugar 2kg', 'Andes Supply', 4.90, 'ACTIVE', systimestamp);

insert into price_history values (1, 1001, date '2026-01-01', null, 18.50, 'Winter catalog');
insert into price_history values (2, 1002, date '2026-01-01', null, 12.80, 'Winter catalog');
insert into price_history values (3, 1003, date '2026-01-01', null, 5.25, 'Bakery baseline');
insert into price_history values (4, 1004, date '2026-01-01', null, 3.40, 'Supplier agreement');
insert into price_history values (5, 1005, date '2026-01-01', null, 4.90, 'Supplier agreement');

commit;

prompt Catalog service model complete.
