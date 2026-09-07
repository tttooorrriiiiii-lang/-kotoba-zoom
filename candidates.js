const FALLBACK_SCORES = {
  "窓":1.55,"境界":3.62,"視点":3.72,"雨":1.46,"天気":2.25,"自然":3.12,"変化":3.94,
  "犬":1.18,"動物":1.68,"生き物":2.08,"生命":3.58,"存在":4.62,"愛":4.42,"感情":4.18,"関係":4.01,
  "仕事":2.74,"活動":3.20,"役割":3.76,"社会":3.70,"カフェ":1.42,"喫茶店":1.30,"休憩":2.78,"交流":3.56,
  "居場所":3.10,"安心":4.16,"所属":4.08,"欲求":4.46,"未来":4.10,"時間":4.22,"可能性":4.64,"未知":4.52,
  "イス":1.12,"椅子":1.12,"家具":1.62,"道具":2.10,"光":2.05,"現象":3.68,"エネルギー":3.28,"知覚":4.12,
  "街":1.80,"場所":2.72,"記憶":4.30,"経験":3.92,"認識":4.48,"世界":4.08,"構造":4.02,"状態":3.90,
  "コーヒー":1.18,"飲み物":1.45,"飲料":1.64,"人間":1.86,"人":1.55,"仲間":2.72,"サービス":3.06,
  "空間":3.24,"環境":3.42,"接続":3.50,"区別":4.08,"解釈":4.52,"目的":4.44,"行動":3.22,"行為":3.50,
  "海":1.35,"水":1.20,"自然環境":2.76,"学校":1.52,"教育":3.82,"学習":3.55,"電車":1.25,"交通":2.54,"移動":3.18,
  "食べ物":1.55,"食品":1.72,"植物":1.72,"乗り物":1.60,"建物":1.62,"施設":2.15,"物":2.05,"もの":2.05,
  "生物":2.02,"概念":4.65,"価値":4.55,"機能":4.08,"目的":4.44,"場所":2.72,"活動":3.20,"現象":3.68
};

const CN_BASE = 'https://api.conceptnet.io';
function scoreTable(){
  return {map:FALLBACK_SCORES, full:false, entries:Object.keys(FALLBACK_SCORES).length, remote:false};
}

function edgeSide(edge, currentNorm){
  const s = norm(nodeLabel(edge.start));
  const e = norm(nodeLabel(edge.end));
  if(s === currentNorm) return {side:'start', other:nodeLabel(edge.end)};
  if(e === currentNorm) return {side:'end', other:nodeLabel(edge.start)};
  return null;
}

function add(map, c){
  const k = norm(c.word);
  if(!k || k.length > 30) return;
  const old = map.get(k);
  if(!old || c.rank > old.rank) map.set(k,c);
}

function scoreOk(dir, currentScore, candidateScore, tolerance=0.10){
  if(currentScore == null || candidateScore == null) return true;
  const delta = candidateScore - currentScore;
  return dir === 'up' ? delta >= -tolerance : delta <= tolerance;
}

function resultItem({word, score, currentScore, relation, relationJa, source, rank, weight, kind}){
  return {
    word,
    score,
    delta: score != null && currentScore != null ? score-currentScore : null,
    relation,
    relationJa,
    source,
    weight,
    kind,
    rank
  };
}

module.exports = async function handler(req,res){
  const raw = Array.isArray(req.query.word) ? req.query.word[0] : req.query.word;
  const dir = req.query.dir === 'down' ? 'down' : 'up';
  const word = String(raw||'').trim();
  if(!word) return res.status(400).json({error:'word is required'});

  const currentNorm = norm(word);
  const uri = conceptUri(word);

  const awd = scoreTable();
  const [isa, all] = await Promise.all([
    fetchJSON(`${CN_BASE}/query?node=${uri}&rel=/r/IsA&other=/c/ja&limit=120`).catch(()=>null),
    fetchJSON(`${CN_BASE}/query?node=${uri}&other=/c/ja&limit=120`).catch(()=>null)
  ]);

  const scoreOf = w => {
    const s = awd.map[norm(w)];
    return Number.isFinite(s) ? s : null;
  };
  const currentScore = scoreOf(word);
  const map = new Map();

  // 1) 本線: IsA の向きだけで、分類として本当に上下する候補を作る。
  for(const edge of isa?.edges || []){
    const pos = edgeSide(edge, currentNorm);
    if(!pos) continue;

    const isCorrectDirection = dir === 'up' ? pos.side === 'start' : pos.side === 'end';
    if(!isCorrectDirection) continue;

    const label = String(pos.other||'').trim();
    if(!label || norm(label) === currentNorm) continue;

    const weight = Number(edge.weight) || 0;
    if(weight < 0.65) continue; // ConceptNetの低信頼ノイズを少し落とす

    const sc = scoreOf(label);
    if(!scoreOk(dir,currentScore,sc,0.18)) continue;

    const rank = 100 + Math.min(weight,5)*4 + (sc!=null && currentScore!=null ? Math.abs(sc-currentScore)*2 : 0);
    add(map, resultItem({
      word:label, score:sc, currentScore,
      relation:'IsA',
      relationJa: dir==='up' ? '分類の抽象化・上位概念' : '分類の具体化・下位概念',
      source:'ConceptNet IsA', rank, weight, kind:'hierarchy'
    }));
  }

  // 2) 補助: 「目的・機能」「全体・文脈」。RelatedTo は抽象度スコアが方向を確認できる時だけ。
  for(const edge of all?.edges || []){
    const pos = edgeSide(edge,currentNorm);
    if(!pos) continue;
    const label = String(pos.other||'').trim();
    if(!label || norm(label)===currentNorm) continue;
    const rel = edge.rel?.label || '';
    const weight = Number(edge.weight) || 0;
    if(weight < 0.7) continue;

    const sc = scoreOf(label);
    const delta = sc!=null && currentScore!=null ? sc-currentScore : null;

    let accept=false, relationJa='', kind='', base=0;

    if(dir==='up'){
      if(rel==='PartOf' && pos.side==='start'){
        accept = scoreOk(dir,currentScore,sc,0.10);
        relationJa='全体・文脈へ広げる'; kind='context'; base=66;
      } else if((rel==='UsedFor' || rel==='MotivatedByGoal') && pos.side==='start'){
        accept = scoreOk(dir,currentScore,sc,0.05);
        relationJa='目的・機能へ抽象化'; kind='purpose'; base=62;
      } else if(rel==='RelatedTo' && delta!=null && delta>=0.30){
        accept=true; relationJa='抽象度で上方向を確認'; kind='score'; base=48;
      }
    } else {
      if(rel==='PartOf' && pos.side==='end'){
        accept = scoreOk(dir,currentScore,sc,0.10);
        relationJa='部分へ具体化'; kind='part'; base=66;
      } else if(rel==='RelatedTo' && delta!=null && delta<=-0.30){
        accept=true; relationJa='抽象度で下方向を確認'; kind='score'; base=48;
      }
    }

    if(!accept) continue;
    const rank = base + Math.min(weight,5)*2 + Math.min(4,Math.abs(delta||0));
    add(map, resultItem({
      word:label, score:sc, currentScore, relation:rel,
      relationJa, source:'ConceptNet + direction check', rank, weight, kind
    }));
  }

  const candidates = [...map.values()]
    .sort((a,b)=>b.rank-a.rank)
    .slice(0,8)
    .map(({rank,...x})=>x);

  res.setHeader('Cache-Control','public, s-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json({
    word, dir, currentScore, candidates,
    status:{conceptnet:!!(isa||all), awdjEntries:awd.entries, awdjFull:awd.full, awdjRemote:awd.remote},
    note: candidates.some(x=>x.kind==='hierarchy')
      ? 'IsAの向きを本線にして、分類として上下する候補を優先しています。'
      : '上位・下位概念が少ない語なので、目的・文脈・抽象度で補助候補を出しています。'
  });
};
