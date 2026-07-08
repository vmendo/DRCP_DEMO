const serviceQueries = {
  catalog: {
    summary: `select count(*) product_count, min(base_price) min_price, max(base_price) max_price from products`,
    list: `select p.product_id, p.sku, p.product_name, c.category_name, p.base_price, p.status
             from products p join product_categories c on c.category_id = p.category_id
            order by p.product_id fetch first 20 rows only`
  },
  inventory: {
    summary: `select count(*) sku_locations, sum(on_hand_qty) on_hand, sum(reserved_qty) reserved from stock_levels`,
    list: `select w.warehouse_code, w.city, s.product_id, s.on_hand_qty, s.reserved_qty, s.reorder_point
             from stock_levels s join warehouses w on w.warehouse_id = s.warehouse_id
            order by w.warehouse_code, s.product_id fetch first 20 rows only`
  },
  orders: {
    summary: `select count(*) order_count, sum(order_total) order_value, max(order_time) latest_order from orders`,
    list: `select order_number, customer_id, order_status, order_total, fulfillment_region, order_time
             from orders order by order_time desc fetch first 20 rows only`
  },
  payments: {
    summary: `select count(*) authorization_count, sum(amount) authorized_amount from payment_authorizations`,
    list: `select authorization_id, order_id, customer_id, amount, currency_code, auth_status, authorized_at
             from payment_authorizations order by authorized_at desc fetch first 20 rows only`
  },
  customers: {
    summary: `select count(*) customer_count, sum(loyalty_points) loyalty_points from customers`,
    list: `select c.customer_id, c.customer_name, s.segment_name, c.city, c.region_code, c.loyalty_points
             from customers c join customer_segments s on s.segment_id = c.segment_id
            order by c.customer_id fetch first 20 rows only`
  }
};

const monitoring = {
  cpoolStats: `select name, num_requests, num_hits, num_misses, num_waits from v$cpool_stats`,
  cpoolClasses: `select cclass_name, num_requests, num_hits, num_misses from v$cpool_cc_stats order by cclass_name`,
  sessionFootprint: `select username, server, status, count(*) session_count
                       from v$session
                      where username like 'DRCP_%'
                      group by username, server, status
                      order by username, server, status`
};

module.exports = { serviceQueries, monitoring };
