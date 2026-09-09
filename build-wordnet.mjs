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

function hashWord(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text).normalize('NFKC').trim()) {
    const cp = ch.codePointAt(0);
    h ^= cp;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % BUCKETS;
}

async function copyBase() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(WN_DIR, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
  await fs.copyFile(path.join(ROOT, 'WORDNET-LICENSE.txt'), path.join(DIST, 'WORDNET-LICENSE.txt'));
}

function addToSetMap(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

async function buildWordNet() {
  console.log('[wordnet] downloading Japanese WordNet v1.1...');
  const res = await fetch(DB_URL, { headers: { 'user-agent': 'kotoba-zoom-build/10' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  console.log(`[wordnet] downloaded ${(gz.length/1024/1024).toFixed(1)} MB; decompressing...`);
  const dbBytes = zlib.gunzipSync(gz);
  console.log(`[wordnet] database ${(dbBytes.length/1024/1024).toFixed(1)} MB; opening...`);

  const wasmPath = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(dbBytes);

  const synsetToWords = new Map();
  const lemmaSenses = new Map();
  const sensePos = new Map();

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
      if (!lemmaSenses.has(lemma)) lemmaSenses.set(lemma, new Set());
      lemmaSenses.get(lemma).add(synset);
      sensePos.set(`${lemma}\u0000${synset}`, pos || '');
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

  const upSynsets = new Map();
  const downSynsets = new Map();
  console.log('[wordnet] reading hypernym links...');
  {
    const stmt = db.prepare(`SELECT synset1, synset2 FROM synlink WHERE link='hype'`);
    while (stmt.step()) {
      const { synset1, synset2 } = stmt.getAsObject();
      if (!synset1 || !synset2) continue;
      addToSetMap(upSynsets, synset1, synset2);
      addToSetMap(downSynsets, synset2, synset1);
    }
    stmt.free();
  }

  const shards = Array.from({ length: BUCKETS }, () => ({}));
  let sensesWritten = 0;
  let wordsWritten = 0;

  console.log('[wordnet] creating compact hypernym/hyponym shards...');
  for (const [lemma, synsetsSet] of lemmaSenses) {
    const senses = [];
    for (const synset of synsetsSet) {
      const up = [];
      const down = [];
      for (const parentSyn of upSynsets.get(synset) || []) {
        for (const w of synsetToWords.get(parentSyn) || []) if (w !== lemma) up.push(w);
      }
      for (const childSyn of downSynsets.get(synset) || []) {
        for (const w of synsetToWords.get(childSyn) || []) if (w !== lemma) down.push(w);
      }
      const uniqUp = [...new Set(up)].slice(0, 16);
      const uniqDown = [...new Set(down)].slice(0, 28);
      if (!uniqUp.length && !uniqDown.length) continue;
      senses.push({
        id: synset,
        pos: sensePos.get(`${lemma}\u0000${synset}`) || '',
        gloss: gloss.get(synset) || '',
        up: uniqUp,
        down: uniqDown
      });
      sensesWritten++;
    }
    if (!senses.length) continue;
    shards[hashWord(lemma)][lemma] = senses;
    wordsWritten++;
  }

  for (let i = 0; i < BUCKETS; i++) {
    await fs.writeFile(path.join(WN_DIR, `${i}.json`), JSON.stringify(shards[i]));
  }
  await fs.writeFile(path.join(WN_DIR, 'meta.json'), JSON.stringify({
    available: true,
    version: 'Japanese WordNet 1.1',
    buckets: BUCKETS,
    words: wordsWritten,
    senses: sensesWritten,
    generatedAt: new Date().toISOString()
  }));
  db.close();
  console.log(`[wordnet] done: ${wordsWritten} words / ${sensesWritten} senses / ${BUCKETS} shards`);
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
