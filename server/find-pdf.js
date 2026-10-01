/* find-pdf.js — 選管の特設ページから開票速報PDFを探す。

     node server/find-pdf.js <raceId> [--json]

   なぜ「URLを設定させる」ではなく「探しに行く」のか:
     速報PDFのURLは投開票日まで存在しない。パス中の連番（001/040/303）は
     CMS が振るもので予測できないため、事前に埋めておくことができない。
     かといって当日に人が貼りに来る運用は、その人が居ないと止まる。

   なぜこれは「推測して書くスクレイパ」ではないのか:
     やっているのは「既知のページから .pdf リンクを集めて名前で絞る」だけで、
     数字は一切読まない。読むのは検証済みの PDF パーサ側で、そこが
     公表値との突き合わせに失敗すれば止まる。つまりここが誤ったPDFを
     掴んでも、誤った数字が入るところまでは進まない。

   レース定義側の設定:
     pdf.indexUrl … 速報が載る特設ページ
     pdf.match    … PDFファイル名にかかる正規表現（既定 kaihyo）
     pdf.prefer   … 複数見つかったときに優先する順の正規表現の配列
                    （確定版があれば中間速報より優先する等）           */
const path = require('path');
const pipeline = require('./pipeline.js');

const DEFAULT_MATCH  = 'kaihyo';
const DEFAULT_PREFER = ['kakutei', 'saishu', 'chukan', ''];

/* href をすべて拾って絶対URLへ直す。HTML パーサは使わない（依存を増やさない）。
   属性の囲みは " ' 無し のいずれもあり得るので3通り見る。            */
function extractPdfLinks(html, baseUrl){
  const out = new Set();
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s">]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null){
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!/\.pdf(\?|#|$)/i.test(raw)) continue;
    try { out.add(new URL(raw, baseUrl).href); } catch { /* 壊れた href は捨てる */ }
  }
  return [...out];
}

function rank(url, prefer){
  const name = decodeURIComponent(url.split('/').pop() || '');
  for (let i = 0; i < prefer.length; i++){
    if (prefer[i] === '' || new RegExp(prefer[i], 'i').test(name)) return i;
  }
  return prefer.length;
}

/* 中間速報はファイル名に時刻が入る（chijisenkaihyo2130.pdf … 2500.pdf）。
   確定版には入らない。同順位なら「時刻なし（＝確定）」→「遅い時刻」の順にする。
   ★2026年の実運用では、時刻付きの訂正版 2300teisei と確定の訂正版 _teisei が
     どちらも "teisei" を含み、名前の照合だけでは中間速報を掴んだ。      */
function reportTime(url){
  const name = decodeURIComponent(url.split('/').pop() || '');
  const m = name.match(/kaihyou?(\d{4})/i);
  return m ? Number(m[1]) : Infinity;     // 時刻なし＝確定版＝最も新しい扱い
}

async function findPdf(raceId, opts = {}){
  const race = pipeline.loadRace(raceId);
  const cfg  = race.pdf ?? {};

  // 明示指定があればそれが最優先。発見は不要。
  if (cfg.url) return { url: cfg.url, source: 'pdf.url', all: [cfg.url] };

  const indexUrl = opts.indexUrl ?? cfg.indexUrl;
  if (!indexUrl){
    throw new Error(`${raceId}: pdf.url も pdf.indexUrl も設定されていません。` +
                    `速報が載るページを pdf.indexUrl に設定してください。`);
  }

  const res = await fetch(indexUrl, {
    headers: { 'User-Agent': 'politisaber/1.0 (personal research)' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  });
  if (!res.ok) throw new Error(`特設ページの取得に失敗: HTTP ${res.status} — ${indexUrl}`);
  const html = await res.text();

  const all = extractPdfLinks(html, indexUrl);
  const matchRe = new RegExp(opts.match ?? cfg.match ?? DEFAULT_MATCH, 'i');
  const hits = all.filter(u => matchRe.test(decodeURIComponent(u.split('/').pop() || '')));

  if (!hits.length){
    const err = new Error(
      `開票速報PDFが見つかりません（${all.length}件のPDFを走査、"${matchRe.source}" に一致なし）。` +
      `まだ公開されていない可能性が高いです。`);
    err.code = 'NOT_PUBLISHED';
    err.all = all;
    throw err;
  }

  const prefer = opts.prefer ?? cfg.prefer ?? DEFAULT_PREFER;
  hits.sort((a,b) => (rank(a,prefer) - rank(b,prefer)) || (reportTime(b) - reportTime(a)));
  return { url: hits[0], source: 'discovered', all: hits, scanned: all.length };
}

if (require.main === module){
  const [raceId, ...rest] = process.argv.slice(2);
  const asJson = rest.includes('--json');
  if (!raceId){ console.error('使い方: node server/find-pdf.js <raceId> [--json]'); process.exit(2); }

  findPdf(raceId)
    .then(r => {
      if (asJson){ console.log(JSON.stringify(r)); return; }
      console.log(`\n  見つかりました（${r.source}）:\n    ${r.url}`);
      if (r.all.length > 1){
        console.log(`\n  他の候補:`);
        for (const u of r.all.slice(1)) console.log(`    ${u}`);
      }
      console.log('');
    })
    .catch(e => {
      if (asJson){ console.log(JSON.stringify({ error: e.message, code: e.code ?? null })); }
      else {
        console.error(`\n  ${e.message}`);
        if (e.all && e.all.length){
          console.error(`\n  ページ内にあったPDF（参考）:`);
          for (const u of e.all.slice(0, 12)) console.error(`    ${path.basename(u)}`);
        }
        console.error('');
      }
      process.exit(e.code === 'NOT_PUBLISHED' ? 3 : 1);
    });
}

module.exports = { findPdf, extractPdfLinks, rank, reportTime };
