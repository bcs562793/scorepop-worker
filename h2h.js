const https = require('https');
const zlib = require('zlib');

// ─── HTTP YARDIMCISI (Mevcut kodundan alındı) ─────────────────────────────
const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': randUA(),
                'Accept': 'text/html,*/*',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Referer': 'https://arsiv.mackolik.com/'
            }
        };

        https.get(url, options, res => {
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
            
            const encoding = res.headers['content-encoding'] || '';
            const chunks = [];

            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const decode = (err, decoded) => err ? resolve(buf.toString('utf8')) : resolve(decoded.toString('utf8'));

                if (encoding === 'gzip') zlib.gunzip(buf, decode);
                else if (encoding === 'deflate') zlib.inflate(buf, (err, result) => {
                    if (err) zlib.inflateRaw(buf, decode);
                    else decode(null, result);
                });
                else resolve(buf.toString('utf8'));
            });
            res.on('error', err => reject(err));
        }).on('error', err => reject(err));
    });
}

// ─── H2H FETCH VE PARSE MANTIĞI ──────────────────────────────────────────────
async function fetchMatchH2H(matchId) {
    const url = `https://arsiv.mackolik.com/Match/Head2Head.aspx?id=${matchId}&s=1`;
    console.log(`\n📡 Fetching H2H data from: ${url}`);
    
    try {
        const raw = await httpGet(url);
        if (raw.includes('Object moved') || raw.includes('PageError.htm')) {
            console.log(`⚠️ H2H sayfası bulunamadı veya Maçkolik engelledi.`);
            return null;
        }
        return parseH2HHtml(raw);
    } catch (e) {
        console.error(`❌ H2H matchId=${matchId}: ${e.message}`);
        return null;
    }
}

function parseH2HHtml(html) {
    const result = { h2h: [], homeForm: [], awayForm: [] };

    // ── 1. H2H SON 5 MAÇ (Senin kodunla aynı) ──
    const h2hRe = /Aralarındaki Maçlar\s*<\/div>[\s\S]*?<table[^>]*class="md-table3"[^>]*>([\s\S]*?)<\/table>/;
    const h2hMatch = html.match(h2hRe);
    if (h2hMatch) {
        const rowRe = /<tr class="row alt[12]">([\s\S]*?)<\/tr>/g;
        let row;
        while ((row = rowRe.exec(h2hMatch[1])) !== null) {
            const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(t => t[1]);
            if (tds.length >= 8) {
                const dateRaw = tds[2].replace(/<[^>]+>/g, '').trim();
                const scoreM = tds[6].match(/\/Mac\/(\d+)\/[^>]+><b>\s*(\d+)\s*-\s*(\d+)/);
                if (!scoreM) continue;
                
                const homeName = tds[5].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
                const awayName = tds[7].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
                
                result.h2h.push({ date: dateRaw, homeTeam: homeName, awayTeam: awayName, score: `${scoreM[2]}-${scoreM[3]}` });
            }
        }
    }

    // ── 2. FORM DURUMU (YENİLENMİŞ, DAHA GÜVENLİ PARSE MANTIĞI) ──
    const formTables = [];
    const formRe = /Form Durumu\s*<\/div>\s*<table[^>]*>([\s\S]*?)<\/table>/g;
    let mForm;
    while ((mForm = formRe.exec(html)) !== null) {
        formTables.push(mForm[1]);
    }

    const parseFormTable = (tableHtml, teamType) => {
        const rows = [];
        // SADECE tr ETİKETİNİ ARIYORUZ (class kısıtlamasını kaldırdık, gi ile büyük/küçük harf duyarsız yaptık)
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let m;
        while ((m = rowRe.exec(tableHtml)) !== null) {
            // Sütunları (td) yakalıyoruz
            const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(t => t[1]);
            
            // Eğer 5'ten az sütun varsa (başlık satırları vs.) atla
            if (tds.length < 5) continue;

            const league = tds[0].replace(/<[^>]+>/g, '').trim();
            const rawDateAndHome = tds[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
            
            const dateMatch = rawDateAndHome.match(/(\d{2}\.\d{2})/);
            const dateStr = dateMatch ? dateMatch[1] : '';
            
            const homeTeam = rawDateAndHome.replace(dateStr, '').replace(/\s+/g, ' ').trim();
            
            const scoreHtml = tds[2];
            const awayTeam = tds[3].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
            const resultHtml = tds[4];

            const scoreM = scoreHtml.match(/<b>\s*(\d+)\s*-\s*(\d+)/i);
            if (!scoreM) continue; // Oynanmamış maç

            const imgM = resultHtml.match(/img5\/(G|B|M)\.png/i);
            const resultVal = imgM ? (imgM[1].toUpperCase() === 'G' ? 'W' : imgM[1].toUpperCase() === 'B' ? 'D' : 'L') : '';

            rows.push({
                league: league,
                date: dateStr,
                homeTeam: homeTeam,
                score: `${scoreM[1]}-${scoreM[2]}`,
                awayTeam: awayTeam,
                result: resultVal
            });
            if (rows.length >= 10) break;
        }
        return rows;
    };

    if (formTables.length > 0) result.homeForm = parseFormTable(formTables[0], 'Ev Sahibi');
    if (formTables.length > 1) result.awayForm = parseFormTable(formTables[1], 'Deplasman');

    return result;
}

// ─── TESTİ ÇALIŞTIR ──────────────────────────────────────────────────────────
(async () => {
    // Terminalden ID gönderilirse onu kullan, yoksa default bir maç ID'si (örn: Fenerbahçe maçı) kullan.
    const matchId = process.argv[2] || '3662235'; 
    
    console.log(`🚀 Test Başlıyor... Maç ID: ${matchId}`);
    const result = await fetchMatchH2H(matchId);
    
    if (result) {
        console.log('\n✅ --- ARALARINDAKİ MAÇLAR (H2H) ---');
        console.table(result.h2h);

        console.log('\n🏠 --- EV SAHİBİ FORM DURUMU ---');
        console.table(result.homeForm);

        console.log('\n✈️  --- DEPLASMAN FORM DURUMU ---');
        console.table(result.awayForm);
    } else {
        console.log('Veri çekilemedi.');
    }
})();
