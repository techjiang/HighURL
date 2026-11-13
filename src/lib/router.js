/** 非法百分号编码不能把请求打成 500，原样保留即可 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * 极简路由：支持 /a/:param/b 与通配 *，不做正则回溯，匹配 O(段数)。
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    const wildcard = pattern.endsWith('/*');
    if (wildcard) segments.pop();
    this.routes.push({ method: method.toUpperCase(), segments, wildcard, handler, pattern });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname, extraMethods = []) {
    const parts = pathname.split('/').filter(Boolean);
    const methods = new Set([method.toUpperCase(), ...extraMethods.map((m) => m.toUpperCase())]);
    for (const route of this.routes) {
      if (!methods.has(route.method)) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i];
        const actual = parts[i];
        if (seg.startsWith(':')) {
          if (actual === undefined) {
            ok = false;
            break;
          }
          params[seg.slice(1)] = safeDecode(actual);
        } else if (seg !== actual) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!route.wildcard && parts.length !== route.segments.length) continue;
      if (route.wildcard) params['*'] = parts.slice(route.segments.length).join('/');
      return { handler: route.handler, params, route };
    }
    return null;
  }
}
