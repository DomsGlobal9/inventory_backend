/**
 * Every route the API actually serves, read from Express's own router rather than from the route
 * files, so a route added anywhere is audited without anybody remembering to list it.
 */
import type { Router } from 'express';

export interface RouteEntry { method: string; path: string; }

/** The mount path Express compiled into a layer's regexp, turned back into a string. */
function mountPath(layer: any): string {
  if (layer.path) return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (!src || src === '^\\/?(?=\\/|$)' || layer.regexp?.fast_slash) return '';
  // e.g. ^\/sales-orders\/?(?=\/|$)  ->  /sales-orders
  let path = src
    .replace('^', '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
  let i = 0;
  path = path.replace(/:param/g, () => `:${layer.keys?.[i++]?.name ?? 'param'}`);
  return path;
}

export function routeTable(router: Router, prefix = ''): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const layer of (router as any).stack ?? []) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: (prefix + p).replace(/\/+/g, '/') });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...routeTable(layer.handle, prefix + mountPath(layer)));
    }
  }
  return out;
}
