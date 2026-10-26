import type { Emitter } from '@codihaus/fastify-extensions';
import { HttpError } from '../errors.js';
import type { NewProduct, Product, ProductModel } from '../models/product.model.js';

export type EventBus = Pick<Emitter<unknown>, 'emitFilter' | 'emitAction'>;

/**
 * Business logic for products. Extensions can change a draft through the
 * `products.create` filter and react to `products.created`; the rules below run
 * after the filter, so no extension can skip them.
 */
export class ProductService {
	constructor(
		private readonly model: ProductModel,
		private readonly events: EventBus,
	) {}

	list(): Product[] {
		return this.model.all();
	}

	get(id: string): Product {
		const product = this.model.findById(id);
		if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', `Product ${id} not found`);
		return product;
	}

	async create(input: NewProduct): Promise<Product> {
		const draft = await this.events.emitFilter<NewProduct>('products.create', { name: input.name, price: input.price }, {}, undefined);
		if (!draft.name) throw new HttpError(400, 'INVALID_PRODUCT', 'name must not be empty');
		if (!(draft.price >= 0)) throw new HttpError(400, 'INVALID_PRODUCT', 'price must be zero or more');

		const product = this.model.insert(draft);
		this.events.emitAction('products.created', { product }, undefined);
		return product;
	}
}
