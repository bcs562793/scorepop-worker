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
log(`🔧 Node: ${process.version}`);

// ─── FİREBASE ────────────────────────────────────────────────────────────────
function initFirebase() {
    log('🔥 Firebase başlatılıyor...');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT bulunamadı!');
    const sa = JSON.parse(raw);
    log(`   ✓ Proje: ${sa.project_id}`);
    initializeApp({ credential: cert(sa) });
    const db = getFirestore();
    log('   ✓ Firestore hazır.');
    return db;
}

// ─── YARDIMCILAR ─────────────────────────────────────────────────────────────
const formatDate = d => d.toISOString().split('T')[0];
const sleep      = ms => new Promise(r => setTimeout(r, ms));

function getTRToday() {
    const s = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Istanbul' });
    return new Date(s.split(',')[0] + 'T00:00:00Z');
}
function getYesterday() { const d = getTRToday(); d.setUTCDate(d.getUTCDate()-1); return d; }
function parseTargetDate(s) { return new Date(s + 'T00:00:00Z'); }

// ─── TAKVİM ──────────────────────────────────────────────────────────────────
async function clickArrow(page, dir) {
    const L = ['.calendar__direction--yesterday','.calendar__navigation--yesterday',
               '[class*="calendar"][class*="yesterday"]','[class*="calLeft"]'];
    const R = ['.calendar__direction--tomorrow','.calendar__navigation--tomorrow',
               '[class*="calendar"][class*="tomorrow"]','[class*="calRight"]'];
    for (const s of (dir==='left'?L:R)) {
        try { await page.waitForSelector(s,{visible:true,timeout:2000}); await page.click(s); return true; } catch(_){}
    }
    return page.evaluate(dir => {
        const kw = dir==='left' ? ['yesterday','prev','left'] : ['tomorrow','next','right'];
        const el = [...document.querySelectorAll('[class*="calendar"] button,[class*="calendar"] span,[class*="calendar"] a')]
            .find(e => { const c=(e.className?.toString()||'').toLowerCase(); return kw.some(k=>c.includes(k)); });
        if (el) { el.click(); return true; }
        const svgs = [...document.querySelectorAll('[class*="calendar"] svg')];
        const idx  = dir==='left' ? 0 : svgs.length-1;
        if (svgs[idx]) { const p=svgs[idx].closest('button,a,span,div'); if(p){p.click();return true;} }
        return false;
    }, dir);
}

async function getPageDate(page) {
    return page.evaluate(() => {
        for (const s of ['.calendar__static','[class*="calendar__static"]','[class*="calDate"]','[class*="calendar"] [class*="date"]']) {
            const el = document.querySelector(s);
            if (el?.innerText?.trim().length > 3) return el.innerText.trim();
        }
        const m = (window.location.hash||'').match(/(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    });
}

async function navigateToDate(page, targetDate) {
    const targetStr = formatDate(targetDate);
    const rawPage   = await getPageDate(page);
    log(`  📅 Hedef: ${targetStr} | Sayfada: ${rawPage||'okunamadı'}`);

    let current = null;
    if (rawPage) {
        const dm = rawPage.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dm) current = new Date(`${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}T00:00:00Z`);
        const im = rawPage.match(/(\d{4}-\d{2}-\d{2})/);
        if (!current && im) current = new Date(im[1]+'T00:00:00Z');
    }
    if (!current) {
        current = getTRToday();
        log(`  ⚠️  Sayfa tarihi okunamadı, bugün varsayıldı: ${formatDate(current)}`);
    }

    const diff  = Math.round((current - targetDate) / 86400000);
    log(`  🔢 ${formatDate(current)} → ${targetStr} = ${diff} adım ${diff>0?'geri':diff<0?'ileri':'(aynı)'}`);
    if (diff === 0) { log('  ✅ Zaten doğru tarih.'); return; }

    const dir   = diff > 0 ? 'left' : 'right';
    const steps = Math.abs(diff);

    for (let i = 0; i < steps; i++) {
        // 🔥 BURASI DÜZELTİLDİ: Artık her tıklamada sabırla bekliyor, tıklamalar yutulmayacak 🔥
        try {
            await Promise.all([
                page.waitForResponse(r=>r.status()===200&&(r.url().includes('feed')||r.url().includes('event')),{timeout:10000}).catch(()=>null),
                clickArrow(page, dir)
            ]);
        } catch(_) { 
            await clickArrow(page, dir); 
        }
        await sleep(2000); // 800ms çok hızlıydı, 2 saniye tam ideal
        log(`    🔄 Adım ${i+1}/${steps} tamamlandı.`);
    }
    
    log(`  ⏳ Tarihe inildi, sayfa renderlanıyor...`);
    await sleep(4000); // 482 maçın ekrana çizilmesi için son bir soluklanma
    const final = await getPageDate(page);
    log(`  ✅ Navigasyon bitti. Sayfada: ${final||'?'}`);
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    // Yavaş scroll → lazy-load tetiklensin, logolar src'ye yazılsın
    await page.evaluate(async () => {
        await new Promise(r => {
            let p = 0;
            const t = setInterval(() => {
                window.scrollBy(0, 400);
                p += 400;
                if (p >= document.body.scrollHeight) { clearInterval(t); r(); }
            }, 300);
        });
        window.scrollTo(0, 0);
    });
    await sleep(3000); // Lazy yüklenen logoların DOM'a yazılmasını bekle

    return page.evaluate((dateStr, timestamp, seasonYear) => {
        const results = [];
        let league = { id:0, name:'Unknown League', country:'Unknown' };

        // 🔥 YENİ SİSTEM: Hem headerLeague hem event__header class'larını tarar 🔥
        const rows = document.querySelectorAll('.headerLeague, .event__header, .event__match, [id^="g_1_"]');

        rows.forEach(el => {
            const cls = (el.className?.toString() || '').toLowerCase();
            const id = el.id || '';

            const isMatch = cls.includes('match') || id.startsWith('g_1_');
            const isHeader = !isMatch && (cls.includes('headerleague') || cls.includes('event__header'));

            // ── LİG BAŞLIĞI İŞLEME ──
            if (isHeader) {
                // SENİN GÖNDERDİĞİN HTML'DEKİ GERÇEK CLASS'LAR (Flashscore'un yeni yapısı)
                const nameEl = el.querySelector('.headerLeague__title-text, .event__title--name');
                const countryEl = el.querySelector('.headerLeague__category-text, .event__title--type');

                if (nameEl) {
                    league.name = nameEl.textContent.trim();
                    league.country = countryEl ? countryEl.textContent.replace(/:/g, '').trim() : "Unknown";
                } else {
                    // Güvenlik Duvarı (Ne olur ne olmaz)
                    const clone = el.cloneNode(true);
                    clone.querySelectorAll('a, button, .event__tabs, svg, .headerLeague__actions').forEach(e => e.remove());
                    const lines = clone.innerText.split('\n').map(l=>l.trim()).filter(Boolean);
                    
                    if (lines.length >= 2) {
                        league.country = lines[0].replace(/:/g, '').trim();
                        league.name = lines[1];
                    } else if (lines.length === 1) {
                        league.name = lines[0];
                        league.country = "Unknown";
                    }
                }

                // Lig adından ID üret
                if (league.name === 'Unknown League' || league.name === '') return;
                
                let h=0;
                for(let i=0;i<league.name.length;i++) h=league.name.charCodeAt(i)+((h<<5)-h);
                league.id = Math.abs(h);
                return;
            }

            // ── MAÇ SATIRI İŞLEME ──
            if (isMatch) {
                const rawText = el.innerText || el.textContent;
                if (!rawText) return;

                const lines = rawText.split('\n').map(l=>l.trim()).filter(Boolean);
                if (lines.length < 5) return;

                const status = lines[0];
                let home=lines[1], away=lines[2], hs=lines[3], as_=lines[4];

                // Kırmızı kart kayması
                if (!isNaN(parseInt(away))) { away=lines[3]; hs=lines[4]; as_=lines[5]; }

                if (!hs || !as_ || hs==='-' || as_==='-' || isNaN(parseInt(hs)) || isNaN(parseInt(as_)) || !isNaN(parseInt(status.charAt(0)))) return;

                const h   = parseInt(hs);
                const a   = parseInt(as_);
                const matchId = id ? (parseInt(id.replace('g_1_',''),36) || Math.floor(Math.random()*1e6)) : Math.floor(Math.random()*1e6);

                // ── MAÇ URL & RAW_ID ──
                const linkEl   = el.querySelector('a.eventRowLink');
                const href     = linkEl ? linkEl.getAttribute('href') : null;
                // href örn: /mac/futbol/crvena-zvezda-ncRzHK14/lille-pfDZL71o/?mid=rqaBOCNH
                // raw_id  → futbol/crvena-zvezda-ncRzHK14/lille-pfDZL71o/
                const rawId = href ? href.replace(/^\/mac\//, '').replace(/\?.*$/, '') : null;

                results.push({
                    fixture: {
                        id: matchId, raw_id: rawId, referee:null, timezone:'Europe/Istanbul',
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
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0,6).join(' | ')}${leagues.length>6?` +${leagues.length-6}`:''}`);
}

// ─── LOGO ZENGİNLEŞTİRME ────────────────────────────────────────────────────
async function enrichLogos(browser, matches) {
    log(`\n🔍 LOGOLAR ÇEKİLİYOR: ${matches.length} maç işlenecek...`);
    const detailPage = await browser.newPage();
    // Ana sayfa ile aynı userAgent — Cloudflare botu tanımasın
    await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await detailPage.setRequestInterception(true);
    detailPage.on('request', r => ['font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const rawId = match.fixture.raw_id;
        if (!rawId) continue;
        log(`  ⏳ [${i+1}/${matches.length}] ${match.teams.home.name} vs ${match.teams.away.name}`);
        try {
            await detailPage.goto(`https://www.flashscore.com.tr/mac/${rawId}#mac-ozeti`, {waitUntil:'domcontentloaded', timeout:15000});
            await detailPage.waitForSelector('.participant__image', {timeout:5000}).catch(()=>null);
            const logos = await detailPage.evaluate(() => {
                const imgs = document.querySelectorAll('.participant__image');
                // src boş string olabilir → || null ile temizle
                const src = img => (img && img.src && img.src.startsWith('http')) ? img.src : null;
                return { home: src(imgs[0]), away: src(imgs[1]) };
            });
            // İlk maçta debug: URL ve sonucu logla
            if (i === 0) {
                const pageUrl = detailPage.url();
                const imgCount = await detailPage.evaluate(() => document.querySelectorAll('.participant__image').length);
                log(`  🔍 DEBUG URL: ${pageUrl}`);
                log(`  🔍 DEBUG .participant__image sayısı: ${imgCount}`);
                log(`  🔍 DEBUG logo[0]: ${JSON.stringify(logos)}`);
            }
            if (logos.home) match.teams.home.logo = logos.home;
            if (logos.away) match.teams.away.logo = logos.away;
        } catch(err) {
            log(`  ⚠️ [${rawId}] Logo çekilemedi: ${err.message}`);
        }
        await sleep(500);
    }

    await detailPage.close();
    return matches;
}

// ─── TEK GÜN ─────────────────────────────────────────────────────────────────
async function processDate(page, db, targetDate, browser) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);
    await navigateToDate(page, targetDate);
    log('⚽ Maçlar toplanıyor...');
    let matches = await collectMatches(page, targetDate);
    log(`🏆 ${matches.length} bitmiş maç.`);
    if (matches.length > 0) {
        matches = await enrichLogos(browser, matches);
        const withLogo = matches.filter(m => m.teams.home.logo || m.teams.away.logo).length;
        log(`🖼️  ${withLogo}/${matches.length} maçın logosu çekildi.`);
        await saveToFirestore(db, dateStr, matches);
    } else {
        const c = await page.evaluate(()=>document.querySelectorAll('.event__match').length);
        log(`  ❌ Bitmiş maç yok. (Sayfada ${c} .event__match var)`);
    }
}

// ─── ANA AKIŞ ─────────────────────────────────────────────────────────────────
(async () => {
    let db, browser;

    try { db = initFirebase(); }
    catch(e) { logErr('💥 Firebase:', e.message); logFile.end(()=>process.exit(1)); return; }

    try {
        log('🌍 Browser başlatılıyor...');
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                   '--disable-gpu','--window-size=1920,1080','--disable-blink-features=AutomationControlled'],
        });
        log('   ✓ Browser hazır.');
    }
    catch(e) { logErr('💥 Browser:', e.message); logFile.end(()=>process.exit(1)); return; }

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.emulateTimezone('Europe/Istanbul');
    await page.setRequestInterception(true);
    // Logo CDN'ine izin ver (static.flashscore.com), diğer görselleri engelle
    page.on('request', r => {
        if (r.resourceType() === 'image')
            return r.url().includes('static.flashscore.com') ? r.continue() : r.abort();
        if (['font', 'media'].includes(r.resourceType())) return r.abort();
        r.continue();
    });

    log("🔍 Flashscore'a bağlanılıyor...");
    try { await page.goto('https://www.flashscore.com.tr/',{waitUntil:'domcontentloaded',timeout:60000}); }
    catch(e) { log('⚠️ Goto timeout:', e.message); }

    const title = await page.title();
    log(`📌 Sayfa: ${title}`);
    if (title.toLowerCase().includes('just a moment')) { log('🛡️ Cloudflare, 20s...'); await sleep(20000); }

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler',{timeout:5000});
        await page.click('#onetrust-accept-btn-handler');
        await sleep(1000);
        log('🍪 Çerez kabul edildi.');
    } catch(_) {}
    await sleep(2000);

    try {
        if (MODE==='daily') {
            const y = getYesterday();
            log(`📅 TR dün: ${formatDate(y)}`);
            await processDate(page, db, y, browser);
        } else if (MODE==='single') {
            if (!SINGLE) throw new Error('--date gerekli!');
            await processDate(page, db, parseTargetDate(SINGLE), browser);
        } else if (MODE==='backfill') {
            if (!FROM_DATE||!TO_DATE) throw new Error('--from ve --to gerekli!');
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end-start)/86400000)+1;
            log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i=0; i<total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate()+i);
                await processDate(page, db, d, browser);
                if (i<total-1) await sleep(3000+Math.random()*2000);
            }
        }
    } catch(e) {
        logErr('🔴 KRİTİK HATA:', e.stack||e.message);
        await browser.close();
        logFile.end(()=>process.exit(1)); return;
    }

    await browser.close();
    log('\n🏁 Tamamlandı.');
    logFile.end(()=>process.exit(0));
})();
