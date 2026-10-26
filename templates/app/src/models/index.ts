import { ProductModel } from './product.model.js';

export interface AppModels {
	products: ProductModel;
}

export function createModels(): AppModels {
	return {
		products: new ProductModel([
			{ name: 'Notebook', price: 4.5 },
			{ name: 'Desk lamp', price: 29 },
		]),
	};
}
