import { percentOf } from './percent.mjs';

export function applyDiscount(subtotalCents, rule) {
  let discount = 0;
  if (rule && rule.type === 'percent') discount = percentOf(subtotalCents, rule.value);
  else if (rule && rule.type === 'fixed') discount = rule.value;
  discount = Math.min(Math.max(discount, 0), subtotalCents);
  return { discountCents: discount, totalCents: subtotalCents - discount };
}
