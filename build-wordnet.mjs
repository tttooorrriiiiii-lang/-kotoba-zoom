import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const WN_DIR = path.join(DIST, 'wn');
const DB_URL = 'https://github.com/bond-lab/wnja/releases/download/v1.1/wnjpn.db.gz';
const BUCKETS = 128;

function hashText(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text).normalize('NFKC').trim()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % BUCKETS;
}
function addToSetMap(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}
async function copyBase() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(WN_DIR, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
  await fs.copyFile(path.join(ROOT, 'WORDNET-LICENSE.txt'), path.join(DIST, 'WORDNET-LICENSE.txt'));
}

async function buildWordNet() {
  console.log('[wordnet] downloading Japanese WordNet v1.1...');
  const res = await fetch(DB_URL, { headers: { 'user-agent': 'kotoba-zoom-build/10.5' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  console.log(`[wordnet] downloaded ${(gz.length/1024/1024).toFixed(1)} MB; decompressing...`);
  const dbBytes = zlib.gunzipSync(gz);

  const wasmPath = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(dbBytes);

  const synsetToWords = new Map();
  const lemmaToSynsets = new Map();
  const synsetPos = new Map();

  console.log('[wordnet] reading Japanese lemmas and senses...');
  {
    const stmt = db.prepare(`
      SELECT w.lemma AS lemma, w.pos AS pos, s.synset AS synset
      FROM word w
      JOIN sense s ON s.wordid = w.wordid
      WHERE w.lang='jpn' AND s.lang='jpn'
    `);
    while (stmt.step()) {
      const { lemma, pos, synset } = stmt.getAsObject();
      if (!lemma || !synset) continue;
      addToSetMap(synsetToWords, synset, lemma);
      addToSetMap(lemmaToSynsets, lemma, synset);
      if (!synsetPos.has(synset)) synsetPos.set(synset, pos || String(synset).slice(-1));
    }
    stmt.free();
  }

  const gloss = new Map();
  console.log('[wordnet] reading Japanese definitions...');
  try {
    const stmt = db.prepare(`SELECT synset, def FROM synset_def WHERE lang='jpn'`);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (row.synset && row.def && !gloss.has(row.synset)) gloss.set(row.synset, row.def);
    }
    stmt.free();
  } catch (e) {
    console.warn('[wordnet] definitions unavailable:', e.message);
  }

  const up = new Map();
  const down = new Map();
  const attr = new Map();
  const similar = new Map();
  const entail = new Map();
  const cause = new Map();

  console.log('[wordnet] reading semantic links...');
  {
    const stmt = db.prepare(`SELECT synset1, synset2, link FROM synlink WHERE link IN ('hype','attr','sim','enta','caus')`);
    while (stmt.step()) {
      const { synset1, synset2, link } = stmt.getAsObject();
      if (!synset1 || !synset2) continue;
      if (link === 'hype') {
        addToSetMap(up, synset1, synset2);
        addToSetMap(down, synset2, synset1);
      } else if (link === 'attr') {
        addToSetMap(attr, synset1, synset2);
        addToSetMap(attr, synset2, synset1);
      } else if (link === 'sim') {
        addToSetMap(similar, synset1, synset2);
        addToSetMap(similar, synset2, synset1);
      } else if (link === 'enta') {
        addToSetMap(entail, synset1, synset2);
      } else if (link === 'caus') {
        addToSetMap(cause, synset1, synset2);
      }
    }
    stmt.free();
  }

  const relationObjects = (ids) => [...(ids || [])].map(id => ({
    synset: id,
    words: [...(synsetToWords.get(id) || [])].slice(0, 12)
  })).filter(x => x.words.length);

  const lemmaShards = Array.from({ length: BUCKETS }, () => ({}));
  const senseShards = Array.from({ length: BUCKETS }, () => ({}));
  let sensesWritten = 0;

  console.log('[wordnet] creating lemma + synset shards...');
  for (const [lemma, ids] of lemmaToSynsets) {
    lemmaShards[hashText(lemma)][lemma] = [...ids];
  }
  for (const [synset, wordsSet] of synsetToWords) {
    const record = {
      id: synset,
      pos: synsetPos.get(synset) || String(synset).slice(-1),
      gloss: gloss.get(synset) || '',
      words: [...wordsSet].slice(0, 14),
      up: relationObjects(up.get(synset)),
      down: relationObjects(down.get(synset)),
      attr: relationObjects(attr.get(synset)),
      similar: relationObjects(similar.get(synset)),
      entail: relationObjects(entail.get(synset)),
      cause: relationObjects(cause.get(synset))
    };
    senseShards[hashText(synset)][synset] = record;
    sensesWritten++;
  }

  for (let i = 0; i < BUCKETS; i++) {
    await fs.writeFile(path.join(WN_DIR, `l-${i}.json`), JSON.stringify(lemmaShards[i]));
    await fs.writeFile(path.join(WN_DIR, `s-${i}.json`), JSON.stringify(senseShards[i]));
  }
  await fs.writeFile(path.join(WN_DIR, 'meta.json'), JSON.stringify({
    available: true,
    version: 'Japanese WordNet 1.1 / meaning-safe v10.5',
    buckets: BUCKETS,
    words: lemmaToSynsets.size,
    senses: sensesWritten,
    generatedAt: new Date().toISOString()
  }));
  db.close();
  console.log(`[wordnet] done: ${lemmaToSynsets.size} words / ${sensesWritten} synsets / ${BUCKETS}x2 shards`);
}

await copyBase();
try {
  await buildWordNet();
} catch (err) {
  console.error('[wordnet] build failed; deploying fallback mode:', err);
  await fs.writeFile(path.join(WN_DIR, 'meta.json'), JSON.stringify({
    available: false,
    error: String(err?.message || err),
    generatedAt: new Date().toISOString()
  }));
}
