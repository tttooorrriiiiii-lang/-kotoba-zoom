const FALLBACK = {
  "窓":1.55,"境界":3.62,"視点":3.72,"雨":1.46,"天気":2.25,"自然":3.12,"変化":3.94,
  "犬":1.18,"動物":1.68,"生き物":2.08,"生命":3.58,"存在":4.62,"愛":4.42,"感情":4.18,"関係":4.01,
  "仕事":2.74,"活動":3.20,"役割":3.76,"社会":3.70,"カフェ":1.42,"喫茶店":1.30,"休憩":2.78,"交流":3.56,
  "居場所":3.10,"安心":4.16,"所属":4.08,"欲求":4.46,"未来":4.10,"時間":4.22,"可能性":4.64,"未知":4.52,
  "イス":1.12,"椅子":1.12,"家具":1.62,"道具":2.10,"光":2.05,"現象":3.68,"エネルギー":3.28,"知覚":4.12,
  "街":1.80,"場所":2.72,"記憶":4.30,"経験":3.92,"認識":4.48,"世界":4.08,"構造":4.02,"状態":3.90,
  "コーヒー":1.18,"飲み物":1.45,"飲料":1.64,"人間":1.86,"人":1.55,"仲間":2.72,"サービス":3.06,
  "空間":3.24,"環境":3.42,"接続":3.50,"区別":4.08,"解釈":4.52,"目的":4.44,"行動":3.22,"行為":3.50,
  "海":1.35,"水":1.20,"自然環境":2.76,"学校":1.52,"教育":3.82,"学習":3.55,"電車":1.25,"交通":2.54,"移動":3.18
};
const CN_BASE='https://api.conceptnet.io';
const AWD_URLS=[
  'https://sociocom.jp/~data/2019-AWD-J/data/AWD-J_EX.txt',
  'https://sociocom.jp/~data/2019-AWD-J/data/AWD-J.txt'
];
const REL_JA={IsA:'種類・上位概念',RelatedTo:'意味関連',UsedFor:'用途・目的',HasProperty:'性質',CapableOf:'できること',Causes:'結果',MotivatedByGoal:'目的',AtLocation:'場所',PartOf:'部分と全体',HasA:'持つもの',Synonym:'類義',SimilarTo:'類似',Antonym:'反対',CreatedBy:'作り手',ReceivesAction:'受ける作用',CausesDesire:'欲求を生む',Desires:'欲求',HasPrerequisite:'前提',HasSubevent:'過程'};
let awdPromise=null;
function norm(s){return String(s??'').normalize('NFKC').trim().toLowerCase()}
function conceptUri(word){return '/c/ja/'+encodeURIComponent(norm(word).replace(/\s+/g,'_'))}
function idToLabel(id){if(!id||!id.startsWith('/c/ja/'))return'';const p=id.split('/')[3]||'';try{return decodeURIComponent(p).replaceAll('_',' ')}catch{return p.replaceAll('_',' ')}}
async function fetchJSON(url,ms=6500){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{'User-Agent':'kotoba-zoom/3.0'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}
async function fetchText(url,ms=9000){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,redirect:'follow',headers:{'User-Agent':'kotoba-zoom/3.0'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.text()}finally{clearTimeout(t)}}
function parseAwd(text){const out=Object.create(null),rows=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/);let n=0;for(let i=1;i<rows.length;i++){if(!rows[i])continue;const [w,s]=rows[i].split('\t');const v=Number(s);if(!w||!Number.isFinite(v))continue;out[norm(w)]=Math.round(v*100)/100;n++}return n>10000?out:null}
async function loadAwd(){if(awdPromise)return awdPromise;awdPromise=(async()=>{for(const url of AWD_URLS){try{const parsed=parseAwd(await fetchText(url));if(parsed)return {map:parsed,full:Object.keys(parsed).length>100000,entries:Object.keys(parsed).length,remote:true}}catch{}}return {map:FALLBACK,full:false,entries:Object.keys(FALLBACK).length,remote:false}})();return awdPromise}
function edgeOther(edge,currentNorm){const a=edge.start,b=edge.end,al=norm(a?.label||idToLabel(a?.['@id'])),bl=norm(b?.label||idToLabel(b?.['@id']));if(al===currentNorm)return{label:b?.label||idToLabel(b?.['@id']),side:'end'};if(bl===currentNorm)return{label:a?.label||idToLabel(a?.['@id']),side:'start'};return null}
function directionGuess(rel,side,dir){
  if(rel==='IsA'||rel==='PartOf')return dir==='up'?side==='end':side==='start';
  const semanticUp=new Set(['UsedFor','MotivatedByGoal','HasProperty','Causes','CausesDesire','Desires','CapableOf','HasPrerequisite']);
  const semanticDown=new Set(['AtLocation','HasA','CreatedBy','ReceivesAction','HasSubevent']);
  if(dir==='up'&&semanticUp.has(rel))return true;
  if(dir==='down'&&semanticDown.has(rel))return true;
  return ['RelatedTo','Synonym','SimilarTo'].includes(rel);
}
function relationBonus(rel){return({IsA:1.3,UsedFor:1.0,MotivatedByGoal:.95,HasProperty:.8,Causes:.75,PartOf:.7,AtLocation:.55,HasA:.5,RelatedTo:.25,Synonym:.2,SimilarTo:.2}[rel]||.1)}
function add(map,c){const k=norm(c.word);if(!k||k.length>28)return;const old=map.get(k);if(!old||c.relevance>old.relevance)map.set(k,c)}
module.exports=async function handler(req,res){
  const raw=Array.isArray(req.query.word)?req.query.word[0]:req.query.word,dir=req.query.dir==='down'?'down':'up',word=String(raw||'').trim();if(!word)return res.status(400).json({error:'word is required'});
  const currentNorm=norm(word),uri=conceptUri(word);
  const [awd,q,r]=await Promise.all([
    loadAwd(),
    fetchJSON(`${CN_BASE}/query?node=${uri}&other=/c/ja&limit=100`).catch(()=>null),
    fetchJSON(`${CN_BASE}/related${uri}?filter=/c/ja&limit=80`).catch(()=>null)
  ]);
  const scoreOf=w=>{const s=awd.map[norm(w)];return Number.isFinite(s)?s:null},currentScore=scoreOf(word),map=new Map();
  if(q)for(const edge of q.edges||[]){
    const other=edgeOther(edge,currentNorm);if(!other)continue;
    const label=String(other.label||'').trim();if(!label||norm(label)===currentNorm)continue;
    const rel=edge.rel?.label||'RelatedTo',sc=scoreOf(label),delta=sc!=null&&currentScore!=null?sc-currentScore:null;
    const directional=delta!=null?(dir==='up'?delta>=.15:delta<=-.15):directionGuess(rel,other.side,dir);
    if(!directional)continue;
    const weight=Number(edge.weight)||1,relevance=Math.min(5,weight)+relationBonus(rel)+(delta==null?0:Math.min(1.5,Math.abs(delta)*.45));
    add(map,{word:label,score:sc,delta,relation:rel,relationJa:REL_JA[rel]||rel,weight,relevance,source:delta==null?'ConceptNet direction':'ConceptNet + AWD-J'});
  }
  if(r&&map.size<6)for(const item of r.related||[]){
    const label=idToLabel(item['@id']);if(!label||norm(label)===currentNorm)continue;
    const sc=scoreOf(label),delta=sc!=null&&currentScore!=null?sc-currentScore:null;
    if(delta!=null&&(dir==='up'?delta<.15:delta>-.15))continue;
    const weight=Number(item.weight)||0;
    add(map,{word:label,score:sc,delta,relation:'RelatedTo',relationJa:delta==null?'意味関連・方向推定':'意味的に近い',weight,relevance:weight*2+Math.min(1.4,Math.abs(delta||0)*.35),source:'ConceptNet related'});
  }
  const candidates=[...map.values()].sort((a,b)=>b.relevance-a.relevance).slice(0,8).map(({relevance,...x})=>x);
  res.setHeader('Cache-Control','public, s-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({word,dir,currentScore,candidates,status:{conceptnet:!!(q||r),awdjEntries:awd.entries,awdjFull:awd.full,awdjRemote:awd.remote},note:currentScore==null?'AWD-Jに元語がない場合はConceptNetの関係方向から推定しています。':null});
};
