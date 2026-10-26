import type { AppModels } from '../models/index.js';
import { ProductService, type EventBus } from './product.service.js';

export type { EventBus } from './product.service.js';

export interface AppServices {
	products: ProductService;
}

export function createServices(models: AppModels, events: EventBus): AppServices {
	return {
		products: new ProductService(models.products, events),
	};
}
