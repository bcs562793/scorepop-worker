const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ─── LOG ─────────────────────────────────────────────────────────────────────
const logFile = fs.createWriteStream('scraper.log', { flags: 'w' });
function log(...a)    { const m = a.join(' '); console.log(m);    logFile.write(m + '\n'); }
function logErr(...a) { const m = a.join(' '); console.error(m);  logFile.write('[ERR] ' + m + '\n'); }

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

// ─── TAKVİM OKLARINI TIKLA ───────────────────────────────────────────────────
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
        // ✅ FIX: className.toString() — SVG elementlerinde className bir object olabilir
        const el = [...document.querySelectorAll('[class*="calendar"] button,[class*="calendar"] span,[class*="calendar"] a')]
            .find(e => { const c=(e.className?.toString()||'').toLowerCase(); return kw.some(k=>c.includes(k)); });
        if (el) { el.click(); return true; }
        const svgs = [...document.querySelectorAll('[class*="calendar"] svg')];
        const idx  = dir==='left' ? 0 : svgs.length-1;
        if (svgs[idx]) { const p=svgs[idx].closest('button,a,span,div'); if(p){p.click();return true;} }
        return false;
    }, dir);
}

// ─── SAYFADA HANGİ TARİH GÖSTERILIYOR ────────────────────────────────────────
async function getPageDate(page) {
    return page.evaluate(() => {
        const sels = ['.calendar__static','[class*="calendar__static"]','[class*="calDate"]',
                      '[class*="calendar"] [class*="date"]'];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el?.innerText?.trim().length > 3) return el.innerText.trim();
        }
        const m = (window.location.hash||'').match(/(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    });
}

// ─── TARİHE GİT ──────────────────────────────────────────────────────────────
async function navigateToDate(page, targetDate) {
    const targetStr = formatDate(targetDate);
    const rawPage   = await getPageDate(page);
    log(`  📅 Hedef: ${targetStr} | Sayfada: ${rawPage||'okunamadı'}`);

    // Sayfa tarihini parse et
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
        if (i === 0) {
            try {
                await Promise.race([
                    Promise.all([
                        page.waitForResponse(r=>r.status()===200&&(r.url().includes('feed')||r.url().includes('event')),{timeout:10000}),
                        clickArrow(page, dir)
                    ]),
                    sleep(6000).then(()=>clickArrow(page,dir))
                ]);
            } catch(_) { await clickArrow(page,dir); }
            await sleep(3000);
        } else {
            await clickArrow(page,dir);
            await sleep(800);
        }
    }
    await sleep(3000);
    const finalRaw = await getPageDate(page);
    log(`  ✅ Navigasyon bitti. Sayfada: ${finalRaw||'?'}`);
}

// ─── DOM YAPISI KEŞFEDİN ─────────────────────────────────────────────────────
// ✅ FIX: className.toString() kullanıyoruz — SVGAnimatedString crash'ini önler
async function discoverDOM(page) {
    return page.evaluate(() => {
        const classes = new Set();
        document.querySelectorAll('[class*="event__"]').forEach(el => {
            // ✅ className bir string olmayabilir (SVG), toString() ile güvenli hale getir
            const cn = el.className?.toString() || '';
            cn.split(/\s+/).filter(c=>c.includes('event__')).forEach(c=>classes.add(c));
        });

        // İlk .event__match'ten önceki sibling'lar
        const prevSibs = [];
        const fm = document.querySelector('.event__match');
        if (fm) {
            let s = fm.previousElementSibling;
            for (let i=0; i<5&&s; i++, s=s.previousElementSibling) {
                prevSibs.push({
                    cls: s.className?.toString()?.slice(0,120) || '',
                    txt: s.innerText?.trim().slice(0,120) || ''
                });
            }
        }

        return { eventClasses: [...classes].sort(), prevSibs };
    });
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    // DOM keşfi
    const dom = await discoverDOM(page);
    log(`\n  🔬 event__ class'ları: ${dom.eventClasses.join(', ')}`);
    log('  🔬 İlk maç öncesi sibling\'lar:');
    dom.prevSibs.forEach(s => log(`       cls="${s.cls}" → "${s.txt}"`));
    log('');

    // Scroll
    await page.evaluate(async () => {
        await new Promise(r => {
            let p=0;
            const t = setInterval(()=>{ window.scrollBy(0,400); p+=400;
                if(p>=document.body.scrollHeight){clearInterval(t);r();} },150);
        });
    });
    await sleep(1500);

    return page.evaluate((dateStr, timestamp, seasonYear, eventClasses) => {

        function parseLeagueText(raw) {
            const t = (raw||'').trim().replace(/\s+/g,' ');
            const ci = t.indexOf(':');
            if (ci>-1) return { country: t.slice(0,ci).trim(), name: t.slice(ci+1).trim() };
            const di = t.indexOf(' - ');
            if (di>-1) return { country: t.slice(0,di).trim(), name: t.slice(di+3).trim() };
            return { country: 'Unknown', name: t||'Unknown League' };
        }

        function leagueHash(n) {
            let h=0;
            for(let i=0;i<n.length;i++) h=n.charCodeAt(i)+((h<<5)-h);
            return Math.abs(h);
        }

        // ✅ Hem event__header hem de diğer olası header class'larını selector'a ekle
        const headerClass = eventClasses.find(c=>c.toLowerCase().includes('header'));
        const extraSel    = headerClass && headerClass!=='event__header' ? `, .${headerClass}` : '';
        const allRows     = document.querySelectorAll(`.event__header${extraSel}, .event__match`);

        log_results = []; // debug için
        const results = [];
        let league = { id:0, name:'Unknown League', country:'Unknown' };

        allRows.forEach(el => {
            // ✅ SVG için güvenli className okuma
            const cls = (el.className?.toString()||'').toLowerCase();
            const isHeader = cls.includes('header') && !cls.includes('match');

            if (isHeader) {
                // Önce ülke:lig formatını dene
                const txt = el.innerText?.trim().replace(/\s+/g,' ') || '';
                // Tüm doğrudan text node'larını ve span'ları tara
                const parts = [];
                el.childNodes.forEach(n => {
                    if (n.nodeType===3 && n.textContent?.trim()) parts.push(n.textContent.trim()); // text node
                });
                const spanTexts = [...el.querySelectorAll('span,a,strong,bdi')]
                    .map(c=>c.innerText?.trim()).filter(Boolean);

                let parsed;
                if (spanTexts.length >= 2) {
                    // İlk span = ülke, kalan = lig
                    parsed = { country: spanTexts[0], name: spanTexts.slice(1).join(' ') };
                } else if (spanTexts.length === 1) {
                    parsed = parseLeagueText(spanTexts[0]);
                } else {
                    parsed = parseLeagueText(txt);
                }

                if (parsed.name) {
                    league = { id: leagueHash(parsed.name), name: parsed.name, country: parsed.country };
                }
                return;
            }

            if (!cls.includes('match')) return;

            const lines = el.innerText.split('\n').map(l=>l.trim()).filter(Boolean);
            if (lines.length < 5) return;

            const status = lines[0];
            let home=lines[1], away=lines[2], hs=lines[3], as_=lines[4];
            if (!isNaN(parseInt(away))) { away=lines[3]; hs=lines[4]; as_=lines[5]; }

            if (!hs||!as_||hs==='-'||as_==='-'||isNaN(parseInt(hs))||isNaN(parseInt(as_))||!isNaN(parseInt(status.charAt(0)))) return;

            const h=parseInt(hs)||0, a=parseInt(as_)||0;
            const rawId = el.id ? el.id.replace('g_1_','') : '';
            const id    = rawId ? (parseInt(rawId,36)||rawId.split('').reduce((s,c)=>s+c.charCodeAt(0),0)) : Math.floor(Math.random()*1e6);

            results.push({
                fixture: { id, referee:null, timezone:'Europe/Istanbul',
                    date:`${dateStr}T20:00:00+03:00`, timestamp,
                    periods:{first:null,second:null}, venue:{id:null,name:null,city:null},
                    status:{long:'Match Finished',short:'FT',elapsed:90,extra:null} },
                league: { id:league.id, name:league.name, country:league.country,
                    logo:null, flag:null, season:seasonYear, round:'Regular Season', standings:false },
                teams: {
                    home: { id:0, name:home, logo:null, winner:h>a?true:(h===a?null:false) },
                    away: { id:0, name:away, logo:null, winner:a>h?true:(h===a?null:false) }
                },
                goals: { home:h, away:a },
                score: { halftime:{home:null,away:null}, fulltime:{home:h,away:a},
                    extratime:{home:null,away:null}, penalty:{home:null,away:null} }
            });
        });

        return results;
    }, dateStr, timestamp, seasonYear, dom.eventClasses);
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

    // Görselleri engelle ama console error'ları artık loglama (çok fazla ERR_FAILED var, gürültü)
    page.on('request', r => ['image','font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

    log("🔍 Flashscore'a bağlanılıyor...");
    try { await page.goto('https://www.flashscore.com.tr/',{waitUntil:'domcontentloaded',timeout:60000}); }
    catch(e) { log('⚠️ Goto timeout:', e.message); }

    const title = await page.title();
    log(`📌 Sayfa: ${title}`);
    if (title.toLowerCase().includes('just a moment')) { log('🛡️ Cloudflare, 20s...'); await sleep(20000); }

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler',{timeout:5000});
        await page.click('#onetrust-accept-btn-handler'); await sleep(1000);
        log('🍪 Çerez kabul edildi.');
    } catch(_) {}
    await sleep(2000);

    try {
        if (MODE==='daily') {
            const y = getYesterday();
            log(`📅 TR dün: ${formatDate(y)}`);
            await processDate(page, db, y);
        } else if (MODE==='single') {
            if (!SINGLE) throw new Error('--date gerekli!');
            await processDate(page, db, parseTargetDate(SINGLE));
        } else if (MODE==='backfill') {
            if (!FROM_DATE||!TO_DATE) throw new Error('--from ve --to gerekli!');
            const start=parseTargetDate(FROM_DATE), end=parseTargetDate(TO_DATE);
            const total=Math.round((end-start)/86400000)+1;
            log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i=0; i<total; i++) {
                const d=new Date(start); d.setUTCDate(start.getUTCDate()+i);
                await processDate(page, db, d);
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
