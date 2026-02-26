const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ─── LOG SİSTEMİ ─────────────────────────────────────────────────────────────
// Hem konsola hem scraper.log dosyasına yazar
const logFile = fs.createWriteStream('scraper.log', { flags: 'w' });
function log(...args) {
    const msg = args.join(' ');
    console.log(msg);
    logFile.write(msg + '\n');
}
function logErr(...args) {
    const msg = args.join(' ');
    console.error(msg);
    logFile.write('[ERROR] ' + msg + '\n');
}

// Tüm yakalanmamış hataları yakala
process.on('uncaughtException', (e) => {
    logErr('💥 UNCAUGHT EXCEPTION:', e.stack || e.message);
    logFile.end(() => process.exit(1));
});
process.on('unhandledRejection', (e) => {
    logErr('💥 UNHANDLED REJECTION:', e?.stack || e);
    logFile.end(() => process.exit(1));
});

// ─── ARGÜMANLAR ──────────────────────────────────────────────────────────────
const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE      = args.mode || 'daily';
const SINGLE    = args.date || null;
const FROM_DATE = args.from || null;
const TO_DATE   = args.to   || null;

log('🤖 ScorePop Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);
log(`🔧 Node: ${process.version} | Platform: ${process.platform}`);

// ─── FİREBASE ────────────────────────────────────────────────────────────────
function initFirebase() {
    log('🔥 Firebase başlatılıyor...');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env değişkeni bulunamadı!');
    log('   ✓ Secret bulundu, parse ediliyor...');
    const sa = JSON.parse(raw);
    log(`   ✓ Proje ID: ${sa.project_id}`);
    initializeApp({ credential: cert(sa) });
    const db = getFirestore();
    log('   ✓ Firestore bağlantısı kuruldu.');
    return db;
}

// ─── TARİH ───────────────────────────────────────────────────────────────────
const formatDate = (d) => d.toISOString().split('T')[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getTRToday() {
    const s = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Istanbul' });
    return new Date(s.split(',')[0] + 'T00:00:00Z');
}
function getYesterday() {
    const d = getTRToday(); d.setUTCDate(d.getUTCDate() - 1); return d;
}
function parseTargetDate(s) { return new Date(s + 'T00:00:00Z'); }

// ─── TAKVİM ──────────────────────────────────────────────────────────────────
async function clickCalendarArrow(page, direction) {
    const leftSel  = ['.calendar__direction--yesterday','.calendar__navigation--yesterday',
                      '[class*="calendar"][class*="yesterday"]','[class*="calLeft"]'];
    const rightSel = ['.calendar__direction--tomorrow','.calendar__navigation--tomorrow',
                      '[class*="calendar"][class*="tomorrow"]','[class*="calRight"]'];
    const sels = direction === 'left' ? leftSel : rightSel;
    for (const s of sels) {
        try { await page.waitForSelector(s,{visible:true,timeout:2000}); await page.click(s); return true; } catch(_){}
    }
    return await page.evaluate((dir) => {
        const kw = dir==='left' ? ['yesterday','prev','left'] : ['tomorrow','next','right'];
        const el = [...document.querySelectorAll('[class*="calendar"] button,[class*="calendar"] span,[class*="calendar"] a')]
            .find(e => kw.some(k => (e.className||'').toLowerCase().includes(k)));
        if (el) { el.click(); return true; }
        const svgs=[...document.querySelectorAll('[class*="calendar"] svg')];
        const idx=dir==='left'?0:svgs.length-1;
        if(svgs[idx]){const p=svgs[idx].closest('button,a,span,div');if(p){p.click();return true;}}
        return false;
    }, direction);
}

async function getPageDate(page) {
    return await page.evaluate(() => {
        for (const s of ['.calendar__static','[class*="calendar__static"]','[class*="calendar"] [class*="date"]']) {
            const el = document.querySelector(s);
            if (el?.innerText?.trim().length > 3) return el.innerText.trim();
        }
        const m = (window.location.hash||'').match(/(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    });
}

async function navigateToDate(page, targetDate) {
    const targetStr = formatDate(targetDate);
    const pageDateRaw = await getPageDate(page);
    log(`  📅 Hedef: ${targetStr} | Sayfada: ${pageDateRaw || 'okunamadı'}`);

    let currentDate = null;
    if (pageDateRaw) {
        const dm = pageDateRaw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dm) currentDate = new Date(`${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}T00:00:00Z`);
        const im = pageDateRaw.match(/(\d{4}-\d{2}-\d{2})/);
        if (!currentDate && im) currentDate = new Date(im[1]+'T00:00:00Z');
    }
    if (!currentDate) { currentDate = getTRToday(); log(`  ⚠️ Sayfa tarihi okunamadı, bugün varsayıldı: ${formatDate(currentDate)}`); }

    const diff  = Math.round((currentDate - targetDate) / 86400000);
    log(`  🔢 Fark: ${diff} gün (${diff > 0 ? 'geri' : diff < 0 ? 'ileri' : 'aynı'})`);
    if (diff === 0) { log('  ✅ Zaten doğru tarih.'); return; }

    const dir = diff > 0 ? 'left' : 'right';
    const steps = Math.abs(diff);

    for (let i = 0; i < steps; i++) {
        if (i === 0) {
            try {
                await Promise.race([
                    Promise.all([
                        page.waitForResponse(r => r.status()===200 && (r.url().includes('feed')||r.url().includes('flashscore')||r.url().includes('event')), {timeout:10000}),
                        clickCalendarArrow(page, dir)
                    ]),
                    sleep(6000).then(() => clickCalendarArrow(page, dir))
                ]);
            } catch(_) { await clickCalendarArrow(page, dir); }
            await sleep(3000);
        } else {
            await clickCalendarArrow(page, dir);
            await sleep(800);
        }
    }
    await sleep(3000);
    const finalDate = await getPageDate(page);
    log(`  ✅ Navigasyon tamamlandı. Sayfada: ${finalDate || '?'}`);
}

// ─── DOM KEŞİF ───────────────────────────────────────────────────────────────
async function discoverDOM(page) {
    return await page.evaluate(() => {
        const eventClasses = new Set();
        document.querySelectorAll('[class*="event__"]').forEach(el =>
            el.className.split(/\s+/).filter(c=>c.includes('event__')).forEach(c=>eventClasses.add(c))
        );
        const firstMatch = document.querySelector('.event__match');
        const prevSibs = [];
        if (firstMatch) {
            let s = firstMatch.previousElementSibling;
            for (let i=0;i<5&&s;i++,s=s.previousElementSibling)
                prevSibs.push({cls: s.className?.slice(0,100), txt: s.innerText?.trim().slice(0,100)});
        }
        return { eventClasses: [...eventClasses].sort(), prevSibs };
    });
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr   = formatDate(targetDate);
    const timestamp = Math.floor(targetDate.getTime() / 1000);
    const seasonYear= targetDate.getFullYear();

    const dom = await discoverDOM(page);
    log(`\n  🔬 event__ class'ları: ${dom.eventClasses.join(', ')}`);
    log(`  🔬 İlk maç öncesi sibling'lar:`);
    dom.prevSibs.forEach(s => log(`       class="${s.cls}" → "${s.txt}"`));

    // Scroll
    await page.evaluate(async () => {
        await new Promise(r => {
            let p=0; const t=setInterval(()=>{ window.scrollBy(0,400); p+=400;
                if(p>=document.body.scrollHeight){clearInterval(t);r();} },150);
        });
    });
    await sleep(1500);

    return await page.evaluate((dateStr, timestamp, seasonYear, eventClasses) => {

        function parseLeagueText(t) {
            t = t.trim().replace(/\s+/g,' ');
            const ci = t.indexOf(':');
            if (ci>-1) return {country:t.slice(0,ci).trim(), name:t.slice(ci+1).trim()};
            const di = t.indexOf(' - ');
            if (di>-1) return {country:t.slice(0,di).trim(), name:t.slice(di+3).trim()};
            return {country:'Unknown', name:t||'Unknown League'};
        }
        function leagueHash(n){let h=0;for(let i=0;i<n.length;i++)h=n.charCodeAt(i)+((h<<5)-h);return Math.abs(h);}

        // Header class'ını bul
        const headerClass = eventClasses.find(c=>c.toLowerCase().includes('header'));
        const headerSel   = headerClass ? '.'+headerClass : '.event__header';

        const allRows = document.querySelectorAll(`${headerSel}, .event__match`);
        const results = [];
        let league = {id:0, name:'Unknown League', country:'Unknown'};

        allRows.forEach(el => {
            const cls = (el.className||'').toLowerCase();
            const isHeader = cls.includes('header') && !cls.includes('match');

            if (isHeader) {
                const spans = [...el.querySelectorAll('span,a,strong,div')]
                    .map(c=>c.innerText?.trim()).filter(Boolean);
                const raw = spans.length >= 2
                    ? spans[0] + ': ' + spans.slice(1).join(' ')
                    : el.innerText||'';
                const p = parseLeagueText(raw);
                league = {id:leagueHash(p.name), name:p.name, country:p.country};
                return;
            }

            if (!cls.includes('match')) return;

            const lines = el.innerText.split('\n').map(l=>l.trim()).filter(Boolean);
            if (lines.length < 5) return;

            const status = lines[0];
            let home=lines[1], away=lines[2], hs=lines[3], as_=lines[4];
            if (!isNaN(parseInt(away))) { away=lines[3]; hs=lines[4]; as_=lines[5]; }

            if (hs==='-'||as_==='-'||isNaN(parseInt(hs))||isNaN(parseInt(as_))||!isNaN(parseInt(status.charAt(0)))) return;

            const h=parseInt(hs)||0, a=parseInt(as_)||0;
            const id=el.id?(parseInt(el.id.replace('g_1_',''),36)||el.id.replace('g_1_','').split('').reduce((s,c)=>s+c.charCodeAt(0),0)):Math.floor(Math.random()*1e6);

            results.push({
                fixture:{id,referee:null,timezone:'Europe/Istanbul',date:`${dateStr}T20:00:00+03:00`,timestamp,
                    periods:{first:null,second:null},venue:{id:null,name:null,city:null},
                    status:{long:'Match Finished',short:'FT',elapsed:90,extra:null}},
                league:{id:league.id,name:league.name,country:league.country,
                    logo:null,flag:null,season:seasonYear,round:'Regular Season',standings:false},
                teams:{
                    home:{id:0,name:home,logo:null,winner:h>a?true:(h===a?null:false)},
                    away:{id:0,name:away,logo:null,winner:a>h?true:(h===a?null:false)}},
                goals:{home:h,away:a},
                score:{halftime:{home:null,away:null},fulltime:{home:h,away:a},
                    extratime:{home:null,away:null},penalty:{home:null,away:null}}
            });
        });
        return results;
    }, dateStr, timestamp, seasonYear, dom.eventClasses);
}

// ─── FİRESTORE ───────────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    await db.collection('archive_matches').doc(dateStr).set({
        fixtures:matches, last_updated:new Date().toISOString(), total_matches:matches.length
    },{merge:true});
    log(`  ✅ ${matches.length} maç → archive_matches/${dateStr}`);
    const leagues=[...new Set(matches.map(m=>`${m.league.country}: ${m.league.name}`))];
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0,6).join(' | ')}${leagues.length>6?` +${leagues.length-6}`:''}`);
}

// ─── TEK GÜN ─────────────────────────────────────────────────────────────────
async function processDate(page, db, targetDate) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);
    await navigateToDate(page, targetDate);
    log('⚽ Maçlar toplanıyor...');
    const matches = await collectMatches(page, targetDate);
    log(`🏆 ${matches.length} bitmiş maç.`);
    if (matches.length > 0) await saveToFirestore(db, dateStr, matches);
    else {
        const c = await page.evaluate(()=>document.querySelectorAll('.event__match').length);
        log(`  ❌ Bitmiş maç yok. (Sayfada ${c} .event__match var)`);
    }
}

// ─── ANA AKIŞ ─────────────────────────────────────────────────────────────────
(async () => {
    let db, browser;
    try {
        db = initFirebase();
    } catch(e) {
        logErr('💥 Firebase hatası:', e.message);
        logFile.end(() => process.exit(1)); return;
    }

    try {
        log('🌍 Browser başlatılıyor...');
        browser = await puppeteer.launch({
            headless:true,
            args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                  '--disable-gpu','--window-size=1920,1080','--disable-blink-features=AutomationControlled'],
        });
        log('   ✓ Browser başlatıldı.');
    } catch(e) {
        logErr('💥 Browser hatası:', e.message);
        logFile.end(() => process.exit(1)); return;
    }

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.emulateTimezone('Europe/Istanbul');
    await page.setRequestInterception(true);
    page.on('request', r=>['image','font','media'].includes(r.resourceType())?r.abort():r.continue());

    // Sayfa hatalarını da logla
    page.on('pageerror', e => log('  [PAGE ERROR]', e.message));
    page.on('console',   m => { if(m.type()==='error') log('  [CONSOLE ERROR]', m.text()); });

    log("🔍 Flashscore'a bağlanılıyor...");
    try {
        await page.goto('https://www.flashscore.com.tr/',{waitUntil:'domcontentloaded',timeout:60000});
    } catch(e) { log('⚠️ Goto timeout:', e.message); }

    const title = await page.title();
    log(`📌 Sayfa başlığı: ${title}`);
    if (title.toLowerCase().includes('just a moment')) {
        log('🛡️ Cloudflare engeli, 20s bekleniyor...'); await sleep(20000);
    }
    try {
        await page.waitForSelector('#onetrust-accept-btn-handler',{timeout:5000});
        await page.click('#onetrust-accept-btn-handler'); await sleep(1000);
        log('🍪 Çerez kabul edildi.');
    } catch(_) {}
    await sleep(2000);

    try {
        if (MODE==='daily') {
            const y = getYesterday();
            log(`📅 TR saatine göre dün: ${formatDate(y)}`);
            await processDate(page, db, y);
        } else if (MODE==='single') {
            if (!SINGLE) throw new Error('--date gerekli!');
            await processDate(page, db, parseTargetDate(SINGLE));
        } else if (MODE==='backfill') {
            if (!FROM_DATE||!TO_DATE) throw new Error('--from ve --to gerekli!');
            const start=parseTargetDate(FROM_DATE), end=parseTargetDate(TO_DATE);
            const total=Math.round((end-start)/86400000)+1;
            log(`🗓️ ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i=0;i<total;i++) {
                const d=new Date(start); d.setUTCDate(start.getUTCDate()+i);
                await processDate(page,db,d);
                if (i<total-1) await sleep(3000+Math.random()*2000);
            }
        }
    } catch(e) {
        logErr('🔴 KRİTİK HATA:', e.stack || e.message);
        await browser.close();
        logFile.end(() => process.exit(1)); return;
    }

    await browser.close();
    log('\n🏁 Operasyon tamamlandı.');
    logFile.end(() => process.exit(0));
})();
