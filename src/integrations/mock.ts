import {CommerceAdapter,Platform,Product,Order} from '../types.js';
export class MockAdapter implements CommerceAdapter {
  constructor(public platform:Platform, private items:Product[]=[]){ }
  async listProducts(){return this.items}
  async searchProducts(q:string){const x=q.toLowerCase();return this.items.filter(p=>(p.title+' '+(p.description||'')).toLowerCase().includes(x)).slice(0,8)}
  async getOrder(_id: string):Promise<Order|null>{return null}
}
