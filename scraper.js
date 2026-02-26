const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ─── LOG ─────────────────────────────────────────────────────────────────────
const logFile = fs.createWriteStream('scraper.log', { flags: 'w' });
function log(...a)    { const m = a.join(' '); console.log(m);   logFile.write(m + '\n'); }
function logErr(...a) { const m = a.join(' '); console.error(m); logFile.write('[ERR] ' + m + '\n'); }

process.on('uncaughtException',  e => { logErr('💥 UNCAUGHT:', e.stack||e.message); logFile.end(()=>process.exit(1)); });
process.on('unhandledRejection', e => { logErr('💥 REJECTION:', e?.stack||e);        logFile.end(()=>process.exit(1)); });

// ─── ARGS ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
    process.argv.slice(2).filter(a=>a.startsWith('--')).map(a=>a.slice(2).split('='))
);
const MODE      = args.mode || 'daily';
const SINGLE    = args.date || null;
const FROM_DATE = args.from || null;
const TO_DATE   = args.to   || null;

log('🤖 ScorePop Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);

// ─── FİREBASE ────────────────────────────────────────────────────────────────
function initFirebase() {
    log('🔥 Firebase başlatılıyor...');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT bulunamadı!');
    const sa = JSON.parse(raw);
    initializeApp({ credential: cert(sa) });
    const db = getFirestore();
    log('   ✓ Firestore hazır.');
    return db;
}

// ─── YARDIMCILAR ─────────────────────────────────────────────────────────────
const formatDate = d => d.toISOString().split('T')[0];
const sleep      = ms => new Promise(r => setTimeout(r, ms));

// Gece 3 hack'ini sildik! Tarayıcı zaten TR saatinde olduğu için sayfadaki "Bugün" gerçek TR bugünüdür.
function getTRToday() {
    const s = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Istanbul' });
    return new Date(s.split(',')[0] + 'T00:00:00Z');
}
function getYesterday() { const d = getTRToday(); d.setUTCDate(d.getUTCDate()-1); return d; }
function parseTargetDate(s) { return new Date(s + 'T00:00:00Z'); }

// ─── TAKVİM ──────────────────────────────────────────────────────────────────
async function clickArrow(page, dir) {
    const L = ['.calendar__direction--yesterday','.calendar__navigation--yesterday'];
    const R = ['.calendar__direction--tomorrow','.calendar__navigation--tomorrow'];
    for (const s of (dir==='left'?L:R)) {
        try { await page.waitForSelector(s,{visible:true,timeout:2000}); await page.click(s); return true; } catch(_){}
    }
    return page.evaluate(dir => {
        const kw = dir==='left' ? ['yesterday','prev','left'] : ['tomorrow','next','right'];
        const el = [...document.querySelectorAll('[class*="calendar"] button, [class*="calendar"] div[role="button"]')]
            .find(e => { const c=(e.className?.toString()||'').toLowerCase(); return kw.some(k=>c.includes(k)); });
        if (el) { el.click(); return true; }
        return false;
    }, dir);
}

async function getPageDate(page) {
    return page.evaluate(() => {
        const el = document.querySelector('.calendar__static, .calendar__datepicker');
        return el ? el.innerText.trim() : null;
    });
}

async function navigateToDate(page, targetDate) {
    const targetStr = formatDate(targetDate);
    const rawPage   = await getPageDate(page);
    log(`  📅 Hedef: ${targetStr} | Sayfada: ${rawPage||'okunamadı'}`);

    let current = getTRToday(); // Her halükarda TR bugünü baz alınıyor

    const diff  = Math.round((current - targetDate) / 86400000);
    log(`  🔢 TR Bugünü (${formatDate(current)}) → Hedef (${targetStr}) = ${diff} adım`);
    if (diff === 0) { log('  ✅ Zaten doğru tarih.'); return; }

    const dir   = diff > 0 ? 'left' : 'right';
    const steps = Math.abs(diff);

    for (let i = 0; i < steps; i++) {
        try {
            await Promise.all([
                page.waitForResponse(r => r.status() === 200 && (r.url().includes('feed') || r.url().includes('event')), {timeout: 10000}).catch(()=>null),
                clickArrow(page, dir)
            ]);
        } catch(_) { await clickArrow(page, dir); }
        await sleep(2000); // Sayfanın çizilmesi için bekle
        log(`    🔄 Adım ${i+1}/${steps} tamamlandı.`);
    }
    await sleep(2000);
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    await page.evaluate(async () => {
        await new Promise(r => {
            let p=0; const t = setInterval(()=>{ window.scrollBy(0,500); p+=500;
                if(p>=document.body.scrollHeight){clearInterval(t);r();} },100);
        });
    });
    await sleep(1000);

    return page.evaluate((dateStr, timestamp, seasonYear) => {
        const results = [];
        let league = { id:0, name:'Unknown League', country:'Unknown' };

        // DOM'da sadece lig başlıklarını ve maçları temiz bir şekilde yakala
        const rows = document.querySelectorAll('.event__header, .event__match');

        rows.forEach(el => {
            const cls = (el.className?.toString() || '').toLowerCase();

            // ── HEADER (Lig Başlığı) ──
            if (cls.includes('event__header')) {
                const typeEl = el.querySelector('.event__title--type');
                const nameEl = el.querySelector('.event__title--name');
                const titleEl = el.querySelector('.event__title');

                if (typeEl && nameEl) {
                    league.country = typeEl.textContent.replace(/:/g, '').trim();
                    league.name = nameEl.textContent.trim();
                } else if (titleEl) {
                    // Puan Durumu vs. sekmelerini sil
                    const clone = titleEl.cloneNode(true);
                    clone.querySelectorAll('.event__tabs, a').forEach(t => t.remove());
                    const txt = clone.textContent.trim().replace(/\s+/g, ' ');
                    const parts = txt.split(':');
                    if (parts.length > 1) {
                        league.country = parts[0].trim();
                        league.name = parts[1].trim();
                    } else {
                        league.name = txt;
                        league.country = "Unknown";
                    }
                } else {
                    return; // İsim yoksa ligi değiştirme
                }

                // Lig adından tutarlı bir ID oluştur
                let h=0; 
                for(let i=0;i<league.name.length;i++) h=league.name.charCodeAt(i)+((h<<5)-h); 
                league.id = Math.abs(h);
                return;
            }

            // ── MAÇ SATIRI ──
            if (cls.includes('event__match')) {
                const lines = (el.innerText || el.textContent).split('\n').map(l=>l.trim()).filter(Boolean);
                if (lines.length < 5) return;

                const status = lines[0];
                let home=lines[1], away=lines[2], hs=lines[3], as_=lines[4];

                // Kırmızı kart kayması
                if (!isNaN(parseInt(away))) { away=lines[3]; hs=lines[4]; as_=lines[5]; }

                // Başlamamış (saat içeren) veya skoru olmayanları atla
                if (!hs || !as_ || hs==='-' || as_==='-' || isNaN(parseInt(hs)) || isNaN(parseInt(as_)) || !isNaN(parseInt(status.charAt(0)))) return;

                const h   = parseInt(hs)||0;
                const a   = parseInt(as_)||0;
                const raw = el.id ? el.id.replace('g_1_','') : '';
                const id  = raw ? (parseInt(raw,36) || Math.floor(Math.random()*1e6)) : Math.floor(Math.random()*1e6);

                results.push({
                    fixture: {
                        id, referee:null, timezone:'Europe/Istanbul',
                        date:`${dateStr}T20:00:00+03:00`, timestamp,
                        periods:{first:null,second:null},
                        venue:{id:null,name:null,city:null},
                        status:{long:'Match Finished',short:'FT',elapsed:90,extra:null}
                    },
                    league: {
                        id:league.id, name:league.name, country:league.country,
                        logo:null, flag:null, season:seasonYear,
                        round:'Regular Season', standings:false
                    },
                    teams: {
                        home: { id:0, name:home, logo:null, winner: h>a ? true : (h===a ? null : false) },
                        away: { id:0, name:away, logo:null, winner: a>h ? true : (h===a ? null : false) }
                    },
                    goals: { home:h, away:a },
                    score: {
                        halftime:  { home:null, away:null },
                        fulltime:  { home:h,    away:a    },
                        extratime: { home:null, away:null  },
                        penalty:   { home:null, away:null  }
                    }
                });
            }
        });

        return results;
    }, dateStr, timestamp, seasonYear);
}

// ─── FİRESTORE ───────────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    await db.collection('archive_matches').doc(dateStr).set({
        fixtures:      matches,
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
    }, { merge: true });

    log(`  ✅ ${matches.length} maç → archive_matches/${dateStr}`);
    const leagues = [...new Set(matches.map(m=>`${m.league.country}: ${m.league.name}`))];
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0,4).join(' | ')}${leagues.length>4?` +${leagues.length-4} daha`:''}`);
}

// ─── TEK GÜN ─────────────────────────────────────────────────────────────────
async function processDate(page, db, targetDate) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);
    await navigateToDate(page, targetDate);
    log('⚽ Maçlar toplanıyor...');
    const matches = await collectMatches(page, targetDate);
    log(`🏆 ${matches.length} bitmiş maç.`);
    if (matches.length > 0) {
        await saveToFirestore(db, dateStr, matches);
    } else {
        log(`  ❌ Bitmiş maç yok.`);
    }
}

// ─── ANA AKIŞ ─────────────────────────────────────────────────────────────────
(async () => {
    let db, browser;

    try { db = initFirebase(); } catch(e) { logErr('💥 Firebase:', e.message); return; }

    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox','--disable-setuid-sandbox','--window-size=1920,1080'],
        });
    } catch(e) { logErr('💥 Browser:', e.message); return; }

    const page = await browser.newPage();
    await page.emulateTimezone('Europe/Istanbul');
    await page.setRequestInterception(true);
    page.on('request', r => ['image','font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

    try { await page.goto('https://www.flashscore.com.tr/',{waitUntil:'domcontentloaded',timeout:60000}); } catch(_) {}

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler',{timeout:5000});
        await page.click('#onetrust-accept-btn-handler');
        await sleep(1000);
    } catch(_) {}

    try {
        if (MODE==='daily') {
            await processDate(page, db, getYesterday());
        } else if (MODE==='single') {
            await processDate(page, db, parseTargetDate(SINGLE));
        } else if (MODE==='backfill') {
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end-start)/86400000)+1;
            for (let i=0; i<total; i++) {
                const d = new Date(start); d.setUTCDate(start.getUTCDate()+i);
                await processDate(page, db, d);
            }
        }
    } catch(e) {
        logErr('🔴 KRİTİK HATA:', e.message);
    }

    await browser.close();
    log('\n🏁 Tamamlandı.');
})();
