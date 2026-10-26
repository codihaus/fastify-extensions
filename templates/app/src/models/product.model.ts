export interface Product {
	id: string;
	name: string;
	price: number;
	createdAt: string;
}

export type NewProduct = Pick<Product, 'name' | 'price'>;

/**
 * Data access for products. This one keeps rows in memory; replace the body with
 * your database client (knex, drizzle, prisma, ...) and keep the method signatures.
 */
export class ProductModel {
	private readonly rows = new Map<string, Product>();
	private sequence = 0;

	constructor(seed: NewProduct[] = []) {
		for (const row of seed) this.insert(row);
	}

	all(): Product[] {
		return [...this.rows.values()];
	}

	findById(id: string): Product | undefined {
		return this.rows.get(id);
	}

	insert(input: NewProduct): Product {
		const product: Product = { id: String(++this.sequence), ...input, createdAt: new Date().toISOString() };
		this.rows.set(product.id, product);
		return product;
	}
}
