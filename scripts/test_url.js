const SCOPES = ['read_products', 'write_products', 'read_orders', 'read_inventory'];
const url = `https://myshop.myshopify.com/admin/oauth/authorize?client_id=123&scope=${encodeURIComponent(SCOPES.join(','))}&state=456&redirect_uri=abc`;
console.log(url);
