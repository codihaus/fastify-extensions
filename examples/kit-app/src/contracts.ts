// Shared contract: the host context type and the service refs. Extensions import
// types and refs from here, never from one another.
import { createServiceRef, type AppKitBaseContext } from '@codihaus/fastify-extensions';

export interface Product {
	id: string;
	name: string;
	price: number;
}

export interface Order {
	id: string;
	productId: string;
	amount: number;
	createdAt: string;
}

export interface Db {
	products: Product[];
	orders: Order[];
}

/** What every extension receives: the kit base context plus host resources. */
export interface AppContext extends AppKitBaseContext {
	db: Db;
	now(): string;
}

export interface AnalyticsService {
	snapshot(): { orders: number; revenue: number };
}

export const analyticsRef = createServiceRef<AnalyticsService>('analytics');
