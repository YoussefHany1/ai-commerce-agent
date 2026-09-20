export type Platform = 'shopify'|'salla'|'zid';
export type Product={id:string;title:string;description?:string;price:number;currency:string;available:boolean;url?:string;sku?:string};
export type Order={id:string;status:string;paymentStatus?:string;total:number;currency:string;customer?:{name?:string;phone?:string;email?:string}};
export interface CommerceAdapter { platform:Platform; listProducts():Promise<Product[]>; getOrder(id:string):Promise<Order|null>; searchProducts(query:string):Promise<Product[]>; }
