function clampLimit(limit, fallback = 20) {
  const n = Number(limit) || fallback;
  return Math.min(Math.max(n, 1), 100);
}

// Coinbase's own Bazaar API doesn't include amountUsd on accepts[] entries at all
// (only ours does), so every mirrored resource — the bulk of the catalog — had no
// USD price and fell back to showing a raw atomic-unit integer ("100000000 units")
// instead of a dollar amount. These are 6-decimal USD-pegged stablecoins on the
// networks this catalog actually sees real volume on — verified directly (each is
// also a payTo asset this project itself pays into or has confirmed on-chain).
// Deliberately NOT a guess-for-every-asset heuristic: an unrecognized asset stays
// unconverted rather than risk mislabeling some other token's price.
const KNOWN_USD_STABLECOINS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Solana USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // Solana USDT
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon (native) USDC
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum USDC
]);

function computedAmountUsd(asset, amount) {
  if (!asset || !amount || !KNOWN_USD_STABLECOINS.has(asset)) return undefined;
  const n = Number(amount);
  return Number.isFinite(n) ? n / 1e6 : undefined;
}

// FTS5 gives special meaning to quotes, *, -, NEAR, AND/OR/NOT etc. Wrapping every
// token in its own quoted phrase (space-joined, implicit AND) makes arbitrary user
// input safe to MATCH against without it ever being parsed as an FTS5 operator.
function toFtsQuery(query) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok.replace(/"/g, '""')}"`)
    .join(' ');
}

// D1 (SQLite) has a real bound-parameter ceiling per statement — one `?` per
// resource id here hit it in production once a single provider (Saylor's own
// listing) crossed ~145 resources, breaking every caller with more rows than
// that (merchantResources, getProvider — both unlimited, unlike the capped
// list/search paths). Chunking keeps this correct at any provider size.
const ACCEPTS_ID_CHUNK = 100;

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function attachAccepts(env, rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const acceptsRows = [];
  for (let i = 0; i < ids.length; i += ACCEPTS_ID_CHUNK) {
    const chunk = ids.slice(i, i + ACCEPTS_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await env.DB
      .prepare(`SELECT * FROM resource_accepts WHERE resource_id IN (${placeholders})`)
      .bind(...chunk)
      .all();
    acceptsRows.push(...results);
  }

  const byResource = {};
  for (const a of acceptsRows) {
    (byResource[a.resource_id] ||= []).push({
      scheme: a.scheme,
      network: a.network,
      payTo: a.pay_to,
      asset: a.asset || undefined,
      amount: a.amount || undefined,
      amountUsd: a.amount_usd ?? computedAmountUsd(a.asset, a.amount),
      maxTimeoutSeconds: a.max_timeout_seconds ?? undefined,
    });
  }

  return rows.map((r) => {
    const metadata = parseJson(r.metadata, undefined);
    const outputSchema = parseJson(r.output_schema, undefined);
    return {
      id: r.id,
      slug: r.slug || String(r.id),
      resource: r.resource_url,
      description: r.description,
      type: 'http',
      serviceName: metadata?.serviceName,
      mimeType: metadata?.mimeType,
      iconUrl: metadata?.iconUrl,
      resourceType: r.resource_type || undefined,
      x402Version: r.x402_version,
      accepts: byResource[r.id] || [],
      outputSchema,
      extensions: metadata?.extensions,
      tags: parseJson(r.tags, []),
      sourceHost: r.listing_host,
      lastUpdated: r.last_updated,
    // Extra fields beyond CDP's wire shape — additive, so existing clients that only
    // read the standard fields are unaffected. Trust/popularity signal for agents
    // choosing between many permissionless (unverified) listings.
    quality: {
      calls30d: r.calls_30d ?? undefined,
      uniquePayers30d: r.unique_payers_30d ?? undefined,
      lastCalledAt: r.last_called_at ?? undefined,
    },
    // Agent-first fields (capabilities/useWhen/doNotUseWhen/sideEffects/permissions/
    // license/repository/documentation/examples), only present when a provider
    // actually supplied them — never fabricated for mirrored resources.
      metadata,
    // Liveness: null/undefined = never checked (not the same as "down"). Only
    // owner-submitted resources are probed — see scripts/check-liveness.mjs.
    liveness: {
      isLive: r.is_live === null || r.is_live === undefined ? undefined : Boolean(r.is_live),
      lastCheckedAt: r.last_checked_at ?? undefined,
      // Rolling reliability over the last N liveness checks (N capped at 10 by
      // scripts/check-liveness.mjs) — null when never checked, not the same as 0/10.
      reliability: r.reliability_checks ? { checks: r.reliability_checks, live: r.reliability_live } : null,
    },
    // true only when the provider proved control via POST /submit — never inferred
    // from hostname or any other heuristic.
      verified: r.listing_source === 'submitted',
    // Paid placement, not a quality signal — see functions/feature.js.
      featured: Boolean(r.featured_until && r.featured_until > new Date().toISOString()),
    };
  });
}

// D1's batch() is a transaction: all statements commit or all roll back.
// Keep catalog counts inside the same batch as owner submissions to avoid
// publishing partially replaced listings (or inconsistent counters).
function catalogStatsStatements(env) {
  return [
    env.DB
      .prepare(
        `UPDATE catalog_stats SET
           listings = (SELECT COUNT(*) FROM listings),
           resources = (SELECT COUNT(*) FROM resources),
           accepts = (SELECT COUNT(*) FROM resource_accepts),
           merchants = (SELECT COUNT(DISTINCT pay_to) FROM resource_accepts),
           networks = (SELECT COUNT(DISTINCT network) FROM resource_accepts),
           calls_30d = (SELECT COALESCE(SUM(calls_30d), 0) FROM resources),
           updated_at = ?
         WHERE id = 1`
      )
      .bind(new Date().toISOString()),
    env.DB.prepare('DELETE FROM network_stats'),
    env.DB.prepare(
      'INSERT INTO network_stats (network, count) SELECT network, COUNT(DISTINCT resource_id) FROM resource_accepts GROUP BY network'
    ),
  ];
}

// Only called from write paths (not page views). See schema.sql for the
// cached aggregate design.
async function recomputeCatalogStats(env) {
  await env.DB.batch(catalogStatsStatements(env));
}

// Subqueries instead of an IN (?, ..., ?) assembled from arbitrarily many IDs.
// These also cover real resubmissions with historic liveness/feature child rows.
function listingDeleteStatements(env, host) {
  return [
    env.DB
      .prepare('DELETE FROM resource_accepts WHERE resource_id IN (SELECT id FROM resources WHERE listing_host = ?)')
      .bind(host),
    env.DB
      .prepare('DELETE FROM liveness_checks WHERE resource_id IN (SELECT id FROM resources WHERE listing_host = ?)')
      .bind(host),
    env.DB
      .prepare('DELETE FROM feature_purchases WHERE resource_id IN (SELECT id FROM resources WHERE listing_host = ?)')
      .bind(host),
    env.DB.prepare('DELETE FROM resources WHERE listing_host = ?').bind(host),
    env.DB.prepare('DELETE FROM listings WHERE host = ?').bind(host),
  ];
}

async function deleteListing(env, host) {
  await env.DB.batch([...listingDeleteStatements(env, host), ...catalogStatsStatements(env)]);
}

// D1 batches of hundreds of prepared INSERTs can exceed its SQL-variable limit.
// Instead bind ONE JSON document and use SQLite JSON1 to ingest both tables in
// TWO set-based INSERTs. No variable count proportional to the manifest size.
// Newly inserted resource IDs are assigned in JSON array order; the second
// statement maps each accepts[] to its resource by row_number() over those IDs.
// Everything, including deletion of an existing claimed listing, is ONE atomic
// batch. A failed write preserves the prior listing and all its child records.
async function upsertListing(env, { host, sourceManifestUrl, manifestName, submittedAt, resources, source = 'submitted' }) {
  // Preserve the precise previous bind semantics (JSON in text columns; nulls;
  // empty descriptions; native numeric USD amounts) before the transactional write.
  const rows = resources.map((r) => ({
    resource: r.resource,
    description: r.description || '',
    x402Version: r.x402Version ?? null,
    outputSchema: r.outputSchema ? JSON.stringify(r.outputSchema) : null,
    tags: JSON.stringify(r.tags || []),
    lastUpdated: r.lastUpdated,
    slug: r.slug || null,
    resourceType: r.resourceType || null,
    metadata: r.metadata ? JSON.stringify(r.metadata) : null,
    accepts: (r.accepts || []).map((a) => ({
      scheme: a.scheme,
      network: a.network,
      payTo: a.payTo,
      asset: a.asset || null,
      amount: a.amount || null,
      amountUsd: a.amountUsd ?? null,
      maxTimeoutSeconds: a.maxTimeoutSeconds ?? null,
    })),
  }));
  const payload = JSON.stringify(rows);

  await env.DB.batch([
    ...listingDeleteStatements(env, host),
    env.DB
      .prepare('INSERT INTO listings (host, source_manifest_url, manifest_name, submitted_at, source) VALUES (?, ?, ?, ?, ?)')
      .bind(host, sourceManifestUrl, manifestName || host, submittedAt, source),
    env.DB
      .prepare(
        `INSERT INTO resources
           (listing_host, resource_url, description, x402_version, output_schema, tags, last_updated, slug, resource_type, metadata)
         SELECT ?, json_extract(j.value, '$.resource'),
           json_extract(j.value, '$.description'), json_extract(j.value, '$.x402Version'),
           json_extract(j.value, '$.outputSchema'), json_extract(j.value, '$.tags'),
           json_extract(j.value, '$.lastUpdated'), json_extract(j.value, '$.slug'),
           json_extract(j.value, '$.resourceType'), json_extract(j.value, '$.metadata')
         FROM json_each(?) AS j
         ORDER BY CAST(j.key AS INTEGER)`
      )
      .bind(host, payload),
    env.DB
      .prepare(
        `INSERT INTO resource_accepts
           (resource_id, scheme, network, pay_to, asset, amount, amount_usd, max_timeout_seconds)
         SELECT ids.id, json_extract(a.value, '$.scheme'),
           json_extract(a.value, '$.network'), json_extract(a.value, '$.payTo'),
           json_extract(a.value, '$.asset'), json_extract(a.value, '$.amount'),
           json_extract(a.value, '$.amountUsd'), json_extract(a.value, '$.maxTimeoutSeconds')
         FROM (
           SELECT id, row_number() OVER (ORDER BY id) - 1 AS manifest_index
           FROM resources WHERE listing_host = ?
         ) AS ids
         JOIN json_each(?) AS j ON CAST(j.key AS INTEGER) = ids.manifest_index
         JOIN json_each(j.value, '$.accepts') AS a`
      )
      .bind(host, payload),
    ...catalogStatsStatements(env),
  ]);
}

async function searchResources(env, { query, network, asset, scheme, payTo, maxUsdPrice, urlSubstring, limit }) {
  const lim = clampLimit(limit);
  const conditions = [];
  const params = [];
  let from = 'resources r';

  if (query) {
    from = 'resources_fts f JOIN resources r ON r.id = f.rowid';
    conditions.push('resources_fts MATCH ?');
    params.push(toFtsQuery(query));
  }

  // accepts[] filters all apply to the SAME accepts entry. Expressed as one EXISTS so
  // the query walks resources in rank/usage order and probes idx_accepts_resource_id
  // per row, stopping at LIMIT. The previous form JOINed resource_accepts and drove
  // from it — a scan of every accepts row (43k+) plus DISTINCT and a temp sort, ~60k
  // row reads per call, which is what exhausted D1's free-tier daily read budget.
  // Only added when an accept-specific filter is set: a resource with zero accepts[]
  // (deliberately free — see priceOf() in src/layout.js) must still be findable by a
  // bare text/urlSubstring query.
  const acceptConds = ['a.resource_id = r.id'];
  const acceptParams = [];
  if (network) { acceptConds.push('a.network = ?'); acceptParams.push(network); }
  if (asset) { acceptConds.push('a.asset = ?'); acceptParams.push(asset); }
  if (scheme) { acceptConds.push('a.scheme = ?'); acceptParams.push(scheme); }
  if (payTo) { acceptConds.push('a.pay_to = ?'); acceptParams.push(payTo); }
  if (maxUsdPrice !== undefined) { acceptConds.push('(a.amount_usd IS NULL OR a.amount_usd <= ?)'); acceptParams.push(Number(maxUsdPrice)); }
  if (acceptParams.length) {
    conditions.push(`EXISTS (SELECT 1 FROM resource_accepts a WHERE ${acceptConds.join(' AND ')})`);
    params.push(...acceptParams);
  }

  if (urlSubstring) {
    conditions.push("r.resource_url LIKE ? ESCAPE '\\'");
    params.push(`%${urlSubstring.replace(/[%_\\]/g, '\\$&')}%`);
  }

  let sql = `SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, l.source AS listing_source
             FROM ${from} JOIN listings l ON l.host = r.listing_host`;
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  // Text queries rank by FTS5 match quality (bm25) first; filter-only queries rank
  // by 30-day call volume (idx_resources_calls_id), so the busiest (most likely
  // still-live, least-likely-spam) resources surface first among otherwise-equal matches.
  sql += query ? ' ORDER BY bm25(resources_fts)' : ' ORDER BY r.calls_30d IS NULL, r.calls_30d DESC, r.id';
  sql += ' LIMIT ?';
  params.push(lim);

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return attachAccepts(env, results);
}

async function listResources(env, { limit, offset, sort }) {
  const lim = clampLimit(limit);
  const off = Math.max(Number(offset) || 0, 0);
  // 'recent' is genuinely recency (insertion order), not a fabricated trending score —
  // used for the homepage's "Recently Added" section when there isn't enough usage
  // data yet to justify a "Trending" claim.
  const orderBy = sort === 'recent' ? 'r.id DESC' : 'r.calls_30d IS NULL, r.calls_30d DESC, r.id';

  const { results } = await env.DB
    .prepare(`SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, l.source AS listing_source FROM resources r JOIN listings l ON l.host = r.listing_host ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(lim, off)
    .all();
  // Was a live `SELECT COUNT(*) FROM resources` — a full 15k+ row scan on every call,
  // fired twice per homepage view (recent + popular sections). Reuses the same
  // precomputed catalog_stats.resources count getStats() reads; see its comment.
  const { resources: total } = await env.DB.prepare('SELECT resources FROM catalog_stats WHERE id = 1').first();

  return { resources: await attachAccepts(env, results), total, limit: lim, offset: off };
}

async function merchantResources(env, payTo) {
  const { results } = await env.DB
    .prepare(
      `SELECT DISTINCT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, l.source AS listing_source
       FROM resources r JOIN resource_accepts a ON a.resource_id = r.id JOIN listings l ON l.host = r.listing_host WHERE a.pay_to = ?
       ORDER BY r.calls_30d IS NULL, r.calls_30d DESC, r.id`
    )
    .bind(payTo)
    .all();
  return attachAccepts(env, results);
}

async function getResourceBySlugOrId(env, key) {
  const isNumeric = /^\d+$/.test(key);
  const row = await env.DB
    .prepare(
      `SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, r.featured_until, l.source AS listing_source
       FROM resources r JOIN listings l ON l.host = r.listing_host WHERE r.slug = ? ${isNumeric ? 'OR r.id = ?' : ''} LIMIT 1`
    )
    .bind(key, ...(isNumeric ? [Number(key)] : []))
    .first();
  if (!row) return null;
  const [resource] = await attachAccepts(env, [row]);
  const listing = await env.DB.prepare('SELECT host, manifest_name, source, source_manifest_url, submitted_at FROM listings WHERE host = ?').bind(row.listing_host).first();
  return { ...resource, provider: listing };
}

async function getProvider(env, host) {
  const listing = await env.DB.prepare('SELECT host, manifest_name, source, source_manifest_url, submitted_at FROM listings WHERE host = ?').bind(host).first();
  if (!listing) return null;
  const { results } = await env.DB
    .prepare(
      `SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, r.featured_until, l.source AS listing_source
       FROM resources r JOIN listings l ON l.host = r.listing_host WHERE r.listing_host = ? ORDER BY r.calls_30d IS NULL, r.calls_30d DESC, r.id`
    )
    .bind(host)
    .all();
  return { provider: listing, resources: await attachAccepts(env, results) };
}

async function resourcesByNetwork(env, network, { limit, offset }) {
  const lim = clampLimit(limit);
  const off = Math.max(Number(offset) || 0, 0);
  // EXISTS, not a JOIN-and-DISTINCT driven from resource_accepts — see searchResources.
  const { results } = await env.DB
    .prepare(
      `SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, l.source AS listing_source
       FROM resources r JOIN listings l ON l.host = r.listing_host
       WHERE EXISTS (SELECT 1 FROM resource_accepts a WHERE a.resource_id = r.id AND a.network = ?)
       ORDER BY r.calls_30d IS NULL, r.calls_30d DESC, r.id LIMIT ? OFFSET ?`
    )
    .bind(network, lim, off)
    .all();
  // Precomputed distinct-resource count per network (recomputeCatalogStats) — was a live
  // COUNT(DISTINCT) over every accepts row on that network.
  const row = await env.DB.prepare('SELECT count AS total FROM network_stats WHERE network = ?').bind(network).first();
  return { resources: await attachAccepts(env, results), total: row ? row.total : 0, limit: lim, offset: off };
}

async function resourcesByCategory(env, resourceType, { limit, offset }) {
  const lim = clampLimit(limit);
  const off = Math.max(Number(offset) || 0, 0);
  const { results } = await env.DB
    .prepare(
      `SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, l.source AS listing_source
       FROM resources r JOIN listings l ON l.host = r.listing_host
       WHERE r.resource_type = ? COLLATE NOCASE ORDER BY r.calls_30d IS NULL, r.calls_30d DESC, r.id LIMIT ? OFFSET ?`
    )
    .bind(resourceType, lim, off)
    .all();
  const { total } = await env.DB
    .prepare('SELECT COUNT(*) AS total FROM resources WHERE resource_type = ? COLLATE NOCASE')
    .bind(resourceType)
    .first();
  return { resources: await attachAccepts(env, results), total, limit: lim, offset: off };
}

async function listCategories(env) {
  const { results } = await env.DB
    .prepare("SELECT resource_type, COUNT(*) AS count FROM resources WHERE resource_type IS NOT NULL AND resource_type != '' GROUP BY resource_type ORDER BY count DESC")
    .all();
  return results;
}

// Was a live `GROUP BY network` over the whole resource_accepts table (~44k rows
// read every /networks view). Reads the precomputed network_stats cache instead —
// see recomputeCatalogStats() and its comment in schema.sql.
async function listNetworks(env) {
  const { results } = await env.DB.prepare('SELECT network, count FROM network_stats ORDER BY count DESC').all();
  return results;
}

function facetLimit(limit) {
  const n = Number(limit) || 25;
  return Math.min(Math.max(n, 1), 100);
}

async function listDiscoveryFacets(env, { limit = 25 } = {}) {
  const lim = facetLimit(limit);
  const now = new Date().toISOString();
  const [networks, assets, schemes, resourceTypes, providers, priceBands, liveness, verification] = await Promise.all([
    env.DB.prepare('SELECT network AS value, count FROM network_stats ORDER BY count DESC LIMIT ?').bind(lim).all(),
    env.DB
      .prepare(
        `SELECT asset AS value, COUNT(DISTINCT resource_id) AS count
         FROM resource_accepts
         WHERE asset IS NOT NULL AND asset != ''
         GROUP BY asset
         ORDER BY count DESC
         LIMIT ?`
      )
      .bind(lim)
      .all(),
    env.DB
      .prepare(
        `SELECT scheme AS value, COUNT(DISTINCT resource_id) AS count
         FROM resource_accepts
         WHERE scheme IS NOT NULL AND scheme != ''
         GROUP BY scheme
         ORDER BY count DESC
         LIMIT ?`
      )
      .bind(lim)
      .all(),
    env.DB
      .prepare(
        `SELECT resource_type AS value, COUNT(*) AS count
         FROM resources
         WHERE resource_type IS NOT NULL AND resource_type != ''
         GROUP BY resource_type
         ORDER BY count DESC
         LIMIT ?`
      )
      .bind(lim)
      .all(),
    env.DB
      .prepare(
        `SELECT listing_host AS value, COUNT(*) AS count
         FROM resources
         GROUP BY listing_host
         ORDER BY count DESC
         LIMIT ?`
      )
      .bind(lim)
      .all(),
    env.DB
      .prepare(
        `SELECT
           SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd = 0 THEN 1 ELSE 0 END) AS free,
           SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd > 0 AND amount_usd <= 0.001 THEN 1 ELSE 0 END) AS micro,
           SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd > 0.001 AND amount_usd <= 0.01 THEN 1 ELSE 0 END) AS subCent,
           SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd > 0.01 AND amount_usd <= 0.1 THEN 1 ELSE 0 END) AS cents,
           SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd > 0.1 AND amount_usd <= 1 THEN 1 ELSE 0 END) AS underDollar,
           SUM(CASE WHEN amount_usd IS NOT NULL AND amount_usd > 1 THEN 1 ELSE 0 END) AS overDollar,
           SUM(CASE WHEN amount_usd IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM resource_accepts`
      )
      .first(),
    env.DB
      .prepare(
        `SELECT
           SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) AS live,
           SUM(CASE WHEN is_live = 0 THEN 1 ELSE 0 END) AS down,
           SUM(CASE WHEN is_live IS NULL THEN 1 ELSE 0 END) AS unchecked
         FROM resources`
      )
      .first(),
    env.DB
      .prepare(
        `SELECT
           SUM(CASE WHEN l.source = 'submitted' THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN l.source != 'submitted' THEN 1 ELSE 0 END) AS mirrored,
           SUM(CASE WHEN r.featured_until IS NOT NULL AND r.featured_until > ? THEN 1 ELSE 0 END) AS featured
         FROM resources r
         JOIN listings l ON l.host = r.listing_host`
      )
      .bind(now)
      .first(),
  ]);

  const list = (rows) => rows.results.map((r) => ({ value: r.value, count: r.count }));
  return {
    networks: list(networks),
    assets: list(assets),
    schemes: list(schemes),
    resourceTypes: list(resourceTypes),
    providers: list(providers),
    priceBands: {
      free: priceBands.free || 0,
      micro: priceBands.micro || 0,
      subCent: priceBands.subCent || 0,
      cents: priceBands.cents || 0,
      underDollar: priceBands.underDollar || 0,
      overDollar: priceBands.overDollar || 0,
      unknown: priceBands.unknown || 0,
    },
    liveness: {
      live: liveness.live || 0,
      down: liveness.down || 0,
      unchecked: liveness.unchecked || 0,
    },
    trust: {
      verified: verification.verified || 0,
      mirrored: verification.mirrored || 0,
      featured: verification.featured || 0,
    },
  };
}

// `full: true` adds byNetwork/bySource, each a GROUP BY over the WHOLE
// resource_accepts/listings table (no WHERE to prune) — that's an unavoidable full
// scan every single call, no matter how well-indexed, because an unfiltered
// aggregate has to visit every row. Still opt-in for callers that actually use it,
// like /discovery/stats?full=1 or the MCP get_stats tool.
//
// The totals themselves used to be "cheap by default" in name only — six scalar
// subqueries over resources/resource_accepts, ~60k+ rows read on every single call,
// firing on every homepage/protocol-page view. That's what actually exhausted D1's
// free-tier daily row-read cap (twice). Now reads the precomputed catalog_stats
// row instead — see its comment in schema.sql — so this call is a single-row read
// no matter how large the catalog gets.
async function getStats(env, { full = false } = {}) {
  const totals = await env.DB.prepare('SELECT listings, resources, accepts, merchants, networks, calls_30d FROM catalog_stats WHERE id = 1').first();

  const stats = {
    listings: totals.listings,
    resources: totals.resources,
    accepts: totals.accepts,
    merchants: totals.merchants,
    networks: totals.networks,
    calls30d: totals.calls_30d || 0,
  };

  if (full) {
    const [byNetwork, bySource] = await Promise.all([
      env.DB.prepare('SELECT network, COUNT(*) AS count FROM resource_accepts GROUP BY network ORDER BY count DESC').all(),
      env.DB.prepare('SELECT source, COUNT(*) AS count FROM listings GROUP BY source').all(),
    ]);
    stats.byNetwork = Object.fromEntries(byNetwork.results.map((r) => [r.network, r.count]));
    stats.bySource = Object.fromEntries(bySource.results.map((r) => [r.source, r.count]));
  }

  return stats;
}

async function isRateLimited(env, { clientIp, maxPerHour = 20, maxPerDay = 60 }) {
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const { count: hourCount } = await env.DB
    .prepare('SELECT COUNT(*) AS count FROM submission_log WHERE client_ip = ? AND submitted_at >= ?')
    .bind(clientIp, hourAgo)
    .first();
  if (hourCount >= maxPerHour) return true;

  const { count: dayCount } = await env.DB
    .prepare('SELECT COUNT(*) AS count FROM submission_log WHERE client_ip = ? AND submitted_at >= ?')
    .bind(clientIp, dayAgo)
    .first();
  return dayCount >= maxPerDay;
}

async function logSubmission(env, { clientIp, host }) {
  await env.DB
    .prepare('INSERT INTO submission_log (client_ip, host, submitted_at) VALUES (?, ?, ?)')
    .bind(clientIp, host, new Date().toISOString())
    .run();
}

// Paid placement (functions/feature.js) — a marketplace-side fee, never a cut of
// the underlying resource's own x402 payment. See resources.featured_until.
async function getFeaturedResources(env, { limit = 6 } = {}) {
  const { results } = await env.DB
    .prepare(
      `SELECT r.id, r.resource_url, r.description, r.x402_version, r.output_schema, r.tags, r.last_updated, r.listing_host, r.calls_30d, r.unique_payers_30d, r.last_called_at, r.slug, r.resource_type, r.metadata, r.is_live, r.last_checked_at, r.reliability_checks, r.reliability_live, r.featured_until, l.source AS listing_source
       FROM resources r JOIN listings l ON l.host = r.listing_host
       WHERE r.featured_until IS NOT NULL AND r.featured_until > ?
       ORDER BY r.featured_until DESC LIMIT ?`
    )
    .bind(new Date().toISOString(), clampLimit(limit))
    .all();
  return attachAccepts(env, results);
}

// Records a verified purchase and extends featured_until in one batch. Returns
// false (no-op) if tx_signature was already used — the UNIQUE constraint on
// feature_purchases.tx_signature is what actually enforces no-replay; this just
// lets the caller respond honestly instead of surfacing a raw SQL error.
async function recordFeaturePurchase(env, { resourceId, signature, amountUsd, days }) {
  const now = Date.now();
  const base = Math.max(now, await currentFeaturedUntilMs(env, resourceId));
  const until = new Date(base + days * 24 * 60 * 60 * 1000).toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare('INSERT INTO feature_purchases (resource_id, tx_signature, amount_usd, days, featured_until, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(resourceId, signature, amountUsd, days, until, new Date(now).toISOString()),
      env.DB.prepare('UPDATE resources SET featured_until = ? WHERE id = ?').bind(until, resourceId),
    ]);
  } catch (e) {
    if (String(e.message || e).includes('UNIQUE')) return { ok: false, reason: 'this payment has already been used to feature a resource' };
    throw e;
  }
  return { ok: true, featuredUntil: until };
}

async function currentFeaturedUntilMs(env, resourceId) {
  const row = await env.DB.prepare('SELECT featured_until FROM resources WHERE id = ?').bind(resourceId).first();
  const ts = row?.featured_until ? Date.parse(row.featured_until) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

export {
  upsertListing,
  deleteListing,
  searchResources,
  listResources,
  merchantResources,
  getResourceBySlugOrId,
  getProvider,
  getStats,
  resourcesByNetwork,
  resourcesByCategory,
  listCategories,
  listNetworks,
  listDiscoveryFacets,
  isRateLimited,
  logSubmission,
  getFeaturedResources,
  recordFeaturePurchase,
  toFtsQuery,
};
