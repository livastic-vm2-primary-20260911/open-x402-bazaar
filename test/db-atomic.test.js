import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { upsertListing } from '../src/db.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node 18/20 (still supported by this repo) does not ship the built-in SQLite API.
}

function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const batches = [];
  const env = {
    DB: {
      prepare(sql) {
        return { sql, params: [], bind(...params) { return { sql, params }; } };
      },
      async batch(statements) {
        batches.push(statements);
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const { sql, params = [] } of statements) {
            db.prepare(sql).run(...params);
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return [];
      },
    },
  };
  return { db, env, batches };
}

function resources(count) {
  return Array.from({ length: count }, (_, i) => ({
    resource: 'https://example.com/v2/resource-' + i,
    description: 'paid "resource" ' + i,
    x402Version: 2,
    tags: ['x402', 'CSV'],
    lastUpdated: '2026-10-21T00:00:00Z',
    slug: 'test-large-resource-' + i,
    metadata: { serviceName: 'CSV test' + i, examples: ['comma,quoted', '유니코드'] },
    outputSchema: { type: 'object' },
    accepts: Array.from({ length: 4 }, (_, j) => ({
      scheme: 'exact',
      network: j === 0 ? 'eip155:8453' : 'eip155:42161',
      payTo: '0xabc' + j,
      asset: '0xusdc',
      amount: String(i + j + 1),
      amountUsd: (i + j + 1) / 1e6,
      maxTimeoutSeconds: 30,
    })),
  }));
}
function submit(env, rows) {
  return upsertListing(env, {
    host: 'example.com',
    sourceManifestUrl: 'https://example.com/.well-known/x402.json',
    manifestName: 'Test merchant',
    submittedAt: '2026-10-21T00:00:00Z',
    resources: rows,
  });
}
const stats = (db) => ({ ...db.prepare('SELECT listings, resources, accepts, networks FROM catalog_stats').get() });
const counts = (db) => db.prepare('SELECT COUNT(*) AS n FROM resource_accepts').get().n;

test('123-resource 4-rail manifest inserts with bounded variables and correct mapping', { skip: !DatabaseSync }, async () => {
  const { db, env, batches } = harness();
  try {
    await submit(env, resources(123));
    assert.equal(batches.length, 1, 'one atomic D1 transaction, not staged partial batches');
    assert.equal(batches[0].length, 11, 'fixed statement count for arbitrary manifest size');
    assert.ok(batches[0].every((s) => s.params.length <= 5), 'no proportional bind variable lists');
    assert.deepEqual(stats(db), { listings: 1, resources: 123, accepts: 492, networks: 2 });
    assert.equal(counts(db), 492);
    for (const i of [0, 1, 120, 122]) {
      const rows = db.prepare(
        'SELECT r.resource_url, a.amount, a.network FROM resources r JOIN resource_accepts a ON a.resource_id = r.id WHERE r.slug = ? ORDER BY a.id'
      ).all('test-large-resource-' + i);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => r.resource_url.endsWith('resource-' + i)));
      assert.deepEqual(rows.map((r) => r.amount), [String(i + 1), String(i + 2), String(i + 3), String(i + 4)]);
    }
    const metadata = db.prepare('SELECT metadata FROM resources WHERE slug = ?').get('test-large-resource-122');
    assert.equal(JSON.parse(metadata.metadata).examples[1], '유니코드');
  } finally {
    db.close();
  }
});

test('replacement deletes history references and rolls back on bad new manifest', { skip: !DatabaseSync }, async () => {
  const { db, env, batches } = harness();
  try {
    await submit(env, resources(123));
    const oldId = db.prepare('SELECT id FROM resources ORDER BY id LIMIT 1').get().id;
    db.prepare('INSERT INTO liveness_checks (resource_id, checked_at, is_live) VALUES (?, ?, ?)').run(oldId, '2026-10-21', 1);
    db.prepare('INSERT INTO feature_purchases (resource_id, tx_signature, amount_usd, days, featured_until, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(oldId, 'synthetic-sqlite-test', 1, 30, '2026-11-20', '2026-10-21');
    await submit(env, resources(125));
    assert.equal(batches.length, 2);
    assert.deepEqual(stats(db), { listings: 1, resources: 125, accepts: 500, networks: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM liveness_checks').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feature_purchases').get().n, 0);
    const duplicateSlug = resources(126);
    duplicateSlug[125].slug = duplicateSlug[0].slug;
    await assert.rejects(submit(env, duplicateSlug), /UNIQUE constraint failed/);
    assert.deepEqual(stats(db), { listings: 1, resources: 125, accepts: 500, networks: 2 });
    assert.equal(counts(db), 500);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resources WHERE listing_host = ?').get('example.com').n, 125);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings').get().n, 1);
  } finally {
    db.close();
  }
});

test('empty input atomically replaces all existing rows and refreshes stats', { skip: !DatabaseSync }, async () => {
  const { db, env, batches } = harness();
  try {
    await submit(env, resources(2));
    await submit(env, []);
    assert.equal(batches.length, 2);
    assert.deepEqual(stats(db), { listings: 1, resources: 0, accepts: 0, networks: 0 });
    assert.equal(counts(db), 0);
  } finally {
    db.close();
  }
});
