import { hasRole } from './roles.mjs';

export function canAccess(user, resource, action) {
  if (!user || user.disabled === true) return false;
  if (hasRole(user, 'admin')) return true;
  if (action === 'read') return hasRole(user, 'viewer') || hasRole(user, 'editor');
  if (action === 'write') return hasRole(user, 'editor') && user.orgId === resource.orgId;
  return false;
}
