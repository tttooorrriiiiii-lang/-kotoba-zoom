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
  const attrSynsets = new Map();
  const simSynsets = new Map();
  console.log('[wordnet] reading semantic links (hypernym / attribute / similar)...');
  {
    const stmt = db.prepare(`SELECT synset1, synset2, link FROM synlink WHERE link IN ('hype','attr','sim')`);
    while (stmt.step()) {
      const { synset1, synset2, link } = stmt.getAsObject();
      if (!synset1 || !synset2) continue;
      if (link === 'hype') {
        addToSetMap(upSynsets, synset1, synset2);
        addToSetMap(downSynsets, synset2, synset1);
      } else if (link === 'attr') {
        // Attribute is useful as an abstraction bridge for adjectives:
        // e.g. an adjective synset can point to the noun concept/attribute it expresses.
        // Keep it both ways so the browser can safely inspect either endpoint.
        addToSetMap(attrSynsets, synset1, synset2);
        addToSetMap(attrSynsets, synset2, synset1);
      } else if (link === 'sim') {
        addToSetMap(simSynsets, synset1, synset2);
        addToSetMap(simSynsets, synset2, synset1);
      }
    }
    stmt.free();
  }

  const shards = Array.from({ length: BUCKETS }, () => ({}));
  let sensesWritten = 0;
  let wordsWritten = 0;

  console.log('[wordnet] creating compact hierarchy + adjective-bridge shards...');
  for (const [lemma, synsetsSet] of lemmaSenses) {
    const senses = [];
    for (const synset of synsetsSet) {
      // Keep the target synset ID with every relation. This lets the browser
      // stay on the same meaning after the user chooses a hypernym/hyponym,
      // instead of re-opening every sense of the next Japanese label.
      const up = [];
      const down = [];
      const attr = [];
      const similar = [];
      const synonyms = [...(synsetToWords.get(synset) || [])]
        .filter(w => w && w !== lemma)
        .slice(0, 10);
      for (const parentSyn of upSynsets.get(synset) || []) {
        const words = [...(synsetToWords.get(parentSyn) || [])]
          .filter(w => w && w !== lemma)
          .slice(0, 8);
        if (words.length) up.push({ synset: parentSyn, words });
      }
      for (const childSyn of downSynsets.get(synset) || []) {
        const words = [...(synsetToWords.get(childSyn) || [])]
          .filter(w => w && w !== lemma)
          .slice(0, 8);
        if (words.length) down.push({ synset: childSyn, words });
      }
      for (const targetSyn of attrSynsets.get(synset) || []) {
        const words = [...(synsetToWords.get(targetSyn) || [])]
          .filter(w => w && w !== lemma)
          .slice(0, 8);
        if (words.length) attr.push({ synset: targetSyn, words });
      }
      for (const targetSyn of simSynsets.get(synset) || []) {
        const words = [...(synsetToWords.get(targetSyn) || [])]
          .filter(w => w && w !== lemma)
          .slice(0, 8);
        if (words.length) similar.push({ synset: targetSyn, words });
      }
      // v10.3: do not throw away adjective senses just because WordNet has no
      // hypernym/hyponym edge. Adjectives commonly use Attr / Sim instead.
      if (!up.length && !down.length && !attr.length && !similar.length && !synonyms.length) continue;
      senses.push({
        id: synset,
        pos: sensePos.get(`${lemma}\u0000${synset}`) || '',
        gloss: gloss.get(synset) || '',
        up,
        down,
        attr,
        similar,
        synonyms
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
    version: 'Japanese WordNet 1.1 / adjective-bridge v10.3',
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
