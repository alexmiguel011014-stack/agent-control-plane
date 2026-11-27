export function availableUnits(stock, sku) {
  const units = stock[sku];
  return Number.isInteger(units) && units > 0 ? units : 0;
}
