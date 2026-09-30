export type Platform = 'shopify'|'salla'|'zid';
export type Product={id:string;title:string;description?:string;price:number;currency:string;available:boolean;url?:string;sku?:string};
export type Order={id:string;status:string;paymentStatus?:string;total:number;currency:string;customer?:{name?:string;phone?:string;email?:string};placedAt?:Date};
export interface CommerceAdapter { platform:Platform; listProducts():Promise<Product[]>; getOrder(id:string):Promise<Order|null>; searchProducts(query:string):Promise<Product[]>; listOrders(opts?:{since?:Date;until?:Date;limit?:number}):Promise<Order[]>;
  /**
   * Cheapest possible authenticated round trip, used to reject a bad credential at
   * store-creation time rather than letting a tokenless store sit in the database
   * failing every sync job.
   *
   * Optional so an adapter (or a test double) that predates this can be verified by
   * falling back to a scoped capability query instead of failing closed — an
   * unverified install is still better than a store that can never sync, and the
   * caller is told which path it took.
   *
   * Resolves on success, rejects with the platform's own error on failure.
   */
  verify?():Promise<void>;
}
