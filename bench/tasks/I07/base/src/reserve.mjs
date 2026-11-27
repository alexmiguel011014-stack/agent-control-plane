import { availableUnits } from './stock.mjs';

export function reserveStock(stock, requests) {
  const reserved = {};
  const shortages = {};
  for (const request of requests) {
    const take = Math.min(request.qty, availableUnits(stock, request.sku));
    stock[request.sku] = availableUnits(stock, request.sku) - take;
    if (take > 0) reserved[request.sku] = (reserved[request.sku] ?? 0) + take;
    if (take < request.qty) shortages[request.sku] = (shortages[request.sku] ?? 0) + (request.qty - take);
  }
  return { reserved, shortages };
}
