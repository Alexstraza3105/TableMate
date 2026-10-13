const NOTION_VERSION = '2025-09-03';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function notion(env, path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Notion API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function children(env, blockId) {
  let results = [], cursor;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const data = await notion(env, `/blocks/${blockId}/children?${params}`);
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function discoverDatabases(env, rootId) {
  const found = new Map(), visited = new Set();
  async function walk(blockId, depth = 0) {
    if (!blockId || visited.has(blockId) || depth > 5) return;
    visited.add(blockId);
    let blocks;
    try { blocks = await children(env, blockId); } catch { return; }
    for (const block of blocks) {
      if (block.type === 'child_database') found.set(block.id, block.child_database?.title || '');
      if (block.type === 'child_page' && depth < 5) await walk(block.id, depth + 1);
      if (block.has_children && block.type !== 'child_database' && depth < 5) await walk(block.id, depth + 1);
    }
  }
  // The shared root may itself be a database entry/page, so inspect its parent as well.
  try {
    const page = await notion(env, `/pages/${rootId}`);
    if (page.parent?.type === 'database_id' && page.parent.database_id) found.set(page.parent.database_id, '');
    if (page.parent?.type === 'data_source_id' && page.parent.data_source_id) found.set(page.parent.data_source_id, '');
  } catch {}
  await walk(rootId);
  // If the configured page ID is itself a database, add it too.
  try {
    const db = await notion(env, `/databases/${rootId}`);
    if (db.id) found.set(db.id, (db.title || []).map(x => x.plain_text).join(''));
  } catch {}
  return [...found.entries()];
}

function textOf(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(x => x.plain_text ?? x.name ?? '').join('');
  if (typeof v === 'object') {
    if (v.title) return textOf(v.title);
    if (v.rich_text) return textOf(v.rich_text);
    if (v.name) return v.name;
    if (v.url) return v.url;
    if (v.number != null) return String(v.number);
    if (v.select?.name) return v.select.name;
    if (v.status?.name) return v.status.name;
    if (v.date?.start) return v.date.start;
    if (v.checkbox != null) return String(v.checkbox);
    if (v.formula?.string != null) return v.formula.string;
    if (v.formula?.number != null) return String(v.formula.number);
    if (v.type && v[v.type] != null) return textOf(v[v.type]);
  }
  return String(v);
}
function prop(props, names) {
  const key = Object.keys(props || {}).find(k => names.includes(k.toLowerCase().replace(/[^a-z0-9]/g, '')));
  return key ? props[key] : null;
}
function propText(props, names) { return textOf(prop(props, names)); }
function numberValue(props, names, fallback) {
  const p = prop(props, names); if (!p) return fallback;
  const val = p.number ?? p.formula?.number ?? p.rollup?.number;
  const parsed = val == null ? Number(textOf(p)) : Number(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function listValue(p) {
  if (!p) return [];
  const raw = p[p.type];
  if (Array.isArray(raw)) return raw.map(x => x.name || x.plain_text || '').filter(Boolean);
  const text = textOf(p);
  return text ? text.split(/\n|,|;/).map(x => x.trim()).filter(Boolean) : [];
}
function mapRecipe(page, databaseTitle) {
  const p = page.properties || {};
  const titleProp = Object.values(p).find(v => v.type === 'title');
  const name = textOf(titleProp) || propText(p, ['name','recipe','title','recipename']) || 'Untitled recipe';
  const categoryRaw = propText(p, ['category','mealtype','type','meal']) || 'Dinner';
  const normalizedCategory = ['breakfast','lunch','dinner','snack'].find(x => categoryRaw.toLowerCase().includes(x)) || 'Dinner';
  const ingredientProp = prop(p, ['ingredients','ingredient','shoppinglist']);
  const ingredients = listValue(ingredientProp);
  const instructions = propText(p, ['instructions','method','directions','preparation','notes','recipe']);
  const urlProp = prop(p, ['url','recipelink','link','source']);
  const url = (urlProp?.url || urlProp?.rich_text?.[0]?.text?.link?.url || page.url || '').toString();
  const time = numberValue(p, ['time','cookingtime','preptime','minutes'], 30);
  const servings = Math.max(1, numberValue(p, ['servings','serves','portions','yield'], 2));
  const cost = Math.max(0, numberValue(p, ['cost','totalcost','estimatedcost','price'], 0));
  const emoji = propText(p, ['emoji','icon']) || '🍲';
  return { id: `notion-${page.id}`, notionId: page.id, name, category: normalizedCategory[0].toUpperCase()+normalizedCategory.slice(1), time, servings, cost, emoji, ingredients, instructions, url, tags: [databaseTitle].filter(Boolean) };
}

async function queryDataSource(env, dataSourceId) {
  let results = [], cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notion(env, `/data_sources/${dataSourceId}/query`, { method: 'POST', body: JSON.stringify(body) });
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function handleGet({ request, env }) {
  if (!env.NOTION_TOKEN || !env.NOTION_PAGE_ID) {
    return json({ error: 'Server setup is incomplete. Set NOTION_TOKEN and NOTION_PAGE_ID in hosting environment variables.' }, 503);
  }
  try {
    const dbs = await discoverDatabases(env, env.NOTION_PAGE_ID);
    if (!dbs.length) return json({ recipes: [], message: 'No database found beneath the configured Recipes page. Make sure the integration is connected to the actual recipe database, not just a containing page.' });
    const recipes = [], seen = new Set();
    for (const [id, title] of dbs) {
      let database;
      try { database = await notion(env, `/databases/${id}`); } catch { database = null; }
      const sources = database?.data_sources || (database?.object === 'data_source' ? [{ id }] : []);
      for (const source of sources) {
        try {
          const pages = await queryDataSource(env, source.id);
          for (const page of pages) {
            if (seen.has(page.id) || page.object !== 'page') continue;
            seen.add(page.id); recipes.push(mapRecipe(page, title));
          }
        } catch (e) { /* Keep going so one inaccessible database doesn't block others. */ }
      }
    }
    return json({ recipes, count: recipes.length, source: 'notion' });
  } catch (e) {
    const status = e.status === 401 || e.status === 403 ? 502 : 500;
    return json({ error: status === 502 ? 'Notion rejected the token or access. Check NOTION_TOKEN and confirm the recipe database is shared with Tablemate.' : `Notion import failed: ${e.message}` }, status);
  }
}
const ALLOWED_ORIGIN = 'https://alexstraza3105.github.io';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsOrigin =
      origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';

    const headers = {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Vary': 'Origin'
    };

    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers
      });
    }

    if (
      url.pathname !== '/' &&
      url.pathname !== '/api/recipes'
    ) {
      return new Response('Not found', {
        status: 404,
        headers
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers
      });
    }

    const response = await handleGet({ request, env });
    const responseHeaders = new Headers(response.headers);

    for (const [key, value] of Object.entries(headers)) {
      responseHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  }
};

