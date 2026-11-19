import { getPermission } from '../../config/permissions';
import { AREAS } from './catalogue';

/** The door's menu (OpenAPI 3.0), written from the published list, so it is always what the door actually does. */
export function openApi(serverUrl: string) {
  const paths: Record<string, any> = {};
  for (const area of AREAS) {
    for (const r of area.routes) {
      const p = `${area.at}${r.path === '/' ? '' : r.path}`.replace(/:([A-Za-z]+)/g, '{$1}') || '/';
      const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      const query = Object.entries(r.query ?? {}).map(([name, description]) => ({ name, in: 'query', required: false, description, schema: { type: 'string' } }));
      paths[p] = paths[p] ?? {};
      paths[p][r.method.toLowerCase()] = {
        tags: [area.title],
        summary: r.summary,
        'x-required-scope': r.scope,
        description: `Needs the permission ${r.scope}${getPermission(r.scope) ? ` (${getPermission(r.scope)!.label})` : ''} in the pass.`,
        parameters: [...params, ...query, { name: 'x-location-id', in: 'header', required: false, description: 'A store of the shop, where the answer depends on the store.', schema: { type: 'string' } }],
        security: [{ modulePass: [] }],
        responses: {
          200: { description: 'What the Inventory app gets for the same request: { success, data, ... }' },
          401: { description: 'No pass, an unknown module or key, a pass older than 10 minutes, or a wrong signature.' },
          403: { description: 'The pass does not hold the permission, said in words.' },
          404: { description: 'Not found, or the shop is not on ScaleEzy.' },
          429: { description: 'Too many calls for this shop from this module (600 a minute). Retry-After says when.' }
        }
      };
    }
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'ScaleEzy Inventory service API',
      version: '1',
      description: 'Inventory\'s features for other ScaleEzy modules, through the same routes the Inventory app uses. '
        + 'Sign a pass with YOUR module\'s private key: RS256, header kid; claims iss (your module), sub, aud "inventory", iat, exp '
        + '(at most 10 minutes later), clientId (the shop), scope (the Inventory permissions you need, e.g. ["customer:view"]), '
        + 'optionally onBehalfOf { userId, name }. Inventory holds only your public key (TRUSTED_SERVICES_KEYS), and may hold it '
        + 'to some permissions. Read only for now.'
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { modulePass: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT (RS256)' } } },
    paths: { '/health': { get: { summary: 'The door is open.', security: [], responses: { 200: { description: '{ success, service: "inventory", api: "service", version: 1 }' } } } }, ...paths }
  };
}
