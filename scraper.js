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

const args = Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')).map(a=>a.slice(2).split('=')));
const MODE      = args.mode || 'daily';
const SINGLE    = args.date || null;
const FROM_DATE = args.from || null;
const TO_DATE   = args.to   || null;

log('🤖 ScorePop Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);

// ─── FİREBASE ────────────────────────────────────────────────────────────────
function initFirebase() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT bulunamadı!');
    initializeApp({ credential: cert(JSON.parse(raw)) });
    return getFirestore();
}

const formatDate = d => d.toISOString().split('T')[0];
const sleep      = ms => new Promise(r => setTimeout(r, ms));

// 🔥 FLASHSCORE SAATİNİ HESAPLAMA 🔥
function getFlashscoreToday() {
    const trDateStr = new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' });
    const trDate = new Date(trDateStr);
    const currentHour = trDate.getHours();

    if (currentHour < 4) {
        trDate.setDate(trDate.getDate() - 1);
    }
    
    const y = trDate.getFullYear();
    const m = String(trDate.getMonth() + 1).padStart(2, '0');
    const d = String(trDate.getDate()).padStart(2, '0');
    
    return new Date(`${y}-${m}-${d}T00:00:00Z`);
}

function getYesterday() { const d = getFlashscoreToday(); d.setUTCDate(d.getUTCDate()-1); return d; }
function parseTargetDate(s) { return new Date(s + 'T00:00:00Z'); }

// ─── TAKVİM TIKLAMA ──────────────────────────────────────────────────────────
async function clickArrow(page, dir) {
    const targetSel = dir === 'left' 
        ? '.calendar__direction--yesterday, [title="Önceki gün"], [title="Previous day"]' 
        : '.calendar__direction--tomorrow, [title="Sonraki gün"], [title="Next day"]';
    
    try { await page.waitForSelector(targetSel, { visible: true, timeout: 5000 }); } catch(e) {}

    return await page.evaluate((dir) => {
        const titleQuery = dir === 'left' ? '[title="Önceki gün"], [title="Previous day"]' : '[title="Sonraki gün"], [title="Next day"]';
        const btnByTitle = document.querySelector(titleQuery);
        if (btnByTitle) { btnByTitle.click(); return true; }

        const kw = dir === 'left' ? ['yesterday','prev','left','önceki'] : ['tomorrow','next','right','sonraki'];
        const elements = [...document.querySelectorAll('div, button, a, span')];
        for (let el of elements) {
            const c = (el.className?.toString() || '').toLowerCase();
            if (c.includes('calendar__direction') || c.includes('calendar__navigation')) {
                if (kw.some(k => c.includes(k))) {
                    el.click(); return true;
                }
            }
        }
        return false;
    }, dir);
}

async function navigateToDate(page, targetDate) {
    const targetStr = formatDate(targetDate);
    let current = getFlashscoreToday();

    const diff  = Math.round((current - targetDate) / 86400000);
    log(`  🔢 Flashscore Bugünü (${formatDate(current)}) → Hedef (${targetStr}) = ${diff} adım`);
    if (diff === 0) { log('  ✅ Zaten doğru tarih.'); return; }

    const dir   = diff > 0 ? 'left' : 'right';
    const steps = Math.abs(diff);

    for (let i = 0; i < steps; i++) {
        const isClicked = await clickArrow(page, dir);
        if (isClicked) {
            try {
                await page.waitForResponse(r => r.status() === 200 && (r.url().includes('feed') || r.url().includes('event')), {timeout: 6000});
            } catch(e) {} 
        }
        await sleep(1500);
        log(`    🔄 Adım ${i+1}/${steps} tamamlandı.`);
    }
    
    log('  ⏳ Hedef güne ulaşıldı, maçların tam yüklenmesi bekleniyor...');
    await sleep(5000); 
}

// ─── 1. AŞAMA: ANA FİKSTÜRÜ TOPLA ────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    await page.evaluate(async () => {
        await new Promise(r => {
            let p=0; const t = setInterval(()=>{ window.scrollBy(0,800); p+=800;
                if(p>=document.body.scrollHeight){clearInterval(t);r();} }, 200);
        });
    });
    await sleep(2000);

    return page.evaluate((dateStr, timestamp, seasonYear) => {
        const results = [];
        let league = { id: 0, name: 'Unknown League', country: 'Unknown' };

        const rows = document.querySelectorAll('.event__header, .event__match, [id^="g_1_"]');

        rows.forEach(el => {
            const cls = (el.className?.toString() || '').toLowerCase();
            const id = el.id || '';

            const isMatch = cls.includes('match') || id.startsWith('g_1_');
            const isHeader = !isMatch && cls.includes('header');

            if (isHeader) {
                const typeEl = el.querySelector('.event__title--type');
                const nameEl = el.querySelector('.event__title--name');

                if (typeEl && nameEl) {
                    league.country = typeEl.textContent.replace(/:/g, '').trim();
                    league.name = nameEl.textContent.trim();
                } else {
                    const titleEl = el.querySelector('.event__title');
                    if (titleEl) {
                        const clone = titleEl.cloneNode(true);
                        clone.querySelectorAll('a, button, .event__tabs, svg').forEach(e => e.remove());
                        
                        const lines = clone.innerText.split('\n').map(l=>l.trim()).filter(Boolean);
                        if (lines.length >= 2) {
                            league.country = lines[0].replace(/:/g, '').trim();
                            league.name = lines[1];
                        } else if (lines.length === 1) {
                            league.name = lines[0];
                            league.country = "Unknown";
                        }
                    } else { return; }
                }

                let h=0;
                for(let i=0;i<league.name.length;i++) h=league.name.charCodeAt(i)+((h<<5)-h);
                league.id = Math.abs(h);
                return;
            }

            if (isMatch) {
                const rawText = el.innerText || el.textContent;
                if (!rawText) return;

                const lines = rawText.split('\n').map(l=>l.trim()).filter(Boolean);
                if (lines.length < 5) return;

                const status = lines[0];
                let home=lines[1], away=lines[2], hs=lines[3], as_=lines[4];

                if (!isNaN(parseInt(away))) { away=lines[3]; hs=lines[4]; as_=lines[5]; }

                if (!hs || !as_ || hs==='-' || as_==='-' || isNaN(parseInt(hs)) || isNaN(parseInt(as_)) || !isNaN(parseInt(status.charAt(0)))) return;

                const h   = parseInt(hs);
                const a   = parseInt(as_);
                
                // 🔥 KRİTİK DEĞİŞİKLİK: Gerçek ID'yi (rqaBOCNH) koruyoruz!
                const rawMatchId = id ? id.replace('g_1_', '') : null;
                const matchId = rawMatchId ? (parseInt(rawMatchId,36) || Math.floor(Math.random()*1e6)) : Math.floor(Math.random()*1e6);

                results.push({
                    fixture: {
                        id: matchId, 
                        raw_id: rawMatchId, // Orijinal ID detay sayfası için tutuluyor
                        referee:null, timezone:'Europe/Istanbul',
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
                    },
                    events: [] // Yeni detaylar buraya dolacak
                });
            }
        });

        return results;
    }, dateStr, timestamp, seasonYear);
}

// ─── 2. AŞAMA: ALT KATMAN (MAÇ DETAYLARINI ÇEK) ──────────────────────────────
async function enrichMatchDetails(browser, matches) {
    log(`\n🔍 ALT KATMAN BAŞLIYOR: ${matches.length} maçın detayları (Logolar & Events) çekilecek...`);
    
    // Arkada gizli bir sekme açıyoruz
    const detailPage = await browser.newPage();
    await detailPage.setRequestInterception(true);
    detailPage.on('request', r => ['font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const rawId = match.fixture.raw_id; 

        if (!rawId) continue;

        log(`  ⏳ [${i+1}/${matches.length}] İşleniyor: ${match.teams.home.name} vs ${match.teams.away.name}`);
        try {
            await detailPage.goto(`https://www.flashscore.com.tr/mac/${rawId}/#mac-ozeti`, {waitUntil: 'domcontentloaded', timeout: 20000});
            await detailPage.waitForSelector('.participant__image', {timeout: 5000}).catch(()=>null);

            const details = await detailPage.evaluate(() => {
                const data = { homeLogo: null, awayLogo: null, events: [] };
                
                // 1. Logoları Topla
                const imgs = document.querySelectorAll('.participant__image');
                if (imgs.length >= 2) {
                    data.homeLogo = imgs[0].src;
                    data.awayLogo = imgs[1].src;
                }

                // 2. Events Topla
                document.querySelectorAll('.smv__participantRow').forEach(row => {
                    const isHome = row.classList.contains('smv__homeParticipant');
                    const time = row.querySelector('.smv__timeBox')?.innerText.trim() || '';
                    const player = row.querySelector('.smv__playerName')?.innerText.trim() || '';
                    
                    if (!player) return;

                    let type = 'Unknown', detail = '';
                    if (row.querySelector('.incidents-goal-soccer')) {
                        type = 'Goal';
                        detail = row.querySelector('.smv__assist')?.innerText.trim() || '';
                    } else if (row.querySelector('.yellowCard-ico')) {
                        type = 'Yellow Card';
                        detail = row.querySelector('.smv__subIncident')?.innerText.trim() || '';
                    } else if (row.querySelector('.redCard-ico')) {
                        type = 'Red Card';
                    } else if (row.querySelector('.incidents-substitution')) {
                        type = 'Substitution';
                        detail = 'Çıkan: ' + (row.querySelector('.smv__subDown')?.innerText.trim() || '');
                    }

                    data.events.push({ time, team: isHome ? 'home' : 'away', type, player, detail });
                });
                return data;
            });

            // Gelen verileri maç objesine yapıştır
            match.teams.home.logo = details.homeLogo;
            match.teams.away.logo = details.awayLogo;
            match.events = details.events;

        } catch (err) {
            log(`  ⚠️ [${rawId}] Detay okuma hatası: ${err.message}`);
        }
        
        // Ban yememek için çok kısa bekleme
        await sleep(1000);
    }

    await detailPage.close();
    return matches;
}

// ─── FİRESTORE KAYIT ─────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    // Sadece saklamak için kullandığımız raw_id'leri veritabanına yazarken temizleyebiliriz (opsiyonel)
    matches.forEach(m => delete m.fixture.raw_id);

    await db.collection('archive_matches').doc(dateStr).set({
        fixtures:      matches,
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
    }, { merge: true });

    log(`\n  ✅ ${matches.length} maç tüm detaylarıyla (Logo & Event) → archive_matches/${dateStr} yoluna yazıldı!`);
}

// ─── TEK GÜN İŞLEME AKIŞI ────────────────────────────────────────────────────
async function processDate(browser, page, db, targetDate) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);
    
    await navigateToDate(page, targetDate);
    
    log('⚽ Ana Liste toplanıyor...');
    let matches = await collectMatches(page, targetDate);
    log(`🏆 ${matches.length} bitmiş maç bulundu.`);
    
    if (matches.length > 0) {
        // 🔥 İşte BİRLEŞME NOKTASI! Kaydetmeden önce alt katmana girip detayları (Events vb) çekiyor 🔥
        matches = await enrichMatchDetails(browser, matches);
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

    try { 
        await page.goto('https://www.flashscore.com.tr/',{waitUntil:'domcontentloaded',timeout:60000}); 
        log('  ⏳ Sitenin arayüzü çiziliyor, bekleniyor...');
        await sleep(5000); 
    } catch(_) {}

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler',{timeout:5000});
        await page.click('#onetrust-accept-btn-handler');
        await sleep(1000);
    } catch(_) {}

    try {
        if (MODE==='daily') {
            await processDate(browser, page, db, getYesterday());
        } else if (MODE==='single') {
            await processDate(browser, page, db, parseTargetDate(SINGLE));
        } else if (MODE==='backfill') {
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end-start)/86400000)+1;
            for (let i=0; i<total; i++) {
                const d = new Date(start); d.setUTCDate(start.getUTCDate()+i);
                
                // Geriye doğru giderken sayfanın sapıtmaması için her gün anasayfayı sıfırlıyoruz
                if (i > 0) {
                    await page.goto('https://www.flashscore.com.tr/',{waitUntil:'domcontentloaded'});
                    await sleep(3000);
                }
                
                await processDate(browser, page, db, d);
            }
        }
    } catch(e) {
        logErr('🔴 KRİTİK HATA:', e.message);
    }

    await browser.close();
    log('\n🏁 Tamamlandı.');
})();
