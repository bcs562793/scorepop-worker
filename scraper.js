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
const DETAIL    = args.detail === 'true'; // Detaylı maç bilgisi çekilsin mi?

log('🤖 ScorePop Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}${DETAIL ? ' | DETAY: AKTİF' : ''}`);
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
        try {
            await Promise.all([
                page.waitForResponse(r=>r.status()===200&&(r.url().includes('feed')||r.url().includes('event')),{timeout:10000}).catch(()=>null),
                clickArrow(page, dir)
            ]);
        } catch(_) {
            await clickArrow(page, dir);
        }
        await sleep(2000);
        log(`    🔄 Adım ${i+1}/${steps} tamamlandı.`);
    }

    log(`  ⏳ Tarihe inildi, sayfa renderlanıyor...`);
    await sleep(4000);
    const final = await getPageDate(page);
    log(`  ✅ Navigasyon bitti. Sayfada: ${final||'?'}`);
}

// ─── MAÇ DETAYLARINI ÇEK ───────────────────────────────────────────────────
async function getMatchDetails(page, matchUrl) {
    try {
        await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        const details = await page.evaluate(() => {
            const result = {
                homeLogo: null,
                awayLogo: null,
                events: [],
                statistics: [],
                referee: null,
                venue: { name: null, city: null, capacity: null },
                attendance: null,
                halftime: { home: null, away: null },
                extratime: { home: null, away: null }
            };

            // Takım logoları
            const homeLogoEl = document.querySelector('.participant__image--home, .smv__teamHome .participant__image, [class*="teamHome"] img');
            const awayLogoEl = document.querySelector('.participant__image--away, .smv__teamAway .participant__image, [class*="teamAway"] img');

            if (homeLogoEl) result.homeLogo = homeLogoEl.src || homeLogoEl.getAttribute('data-src');
            if (awayLogoEl) result.awayLogo = awayLogoEl.src || awayLogoEl.getAttribute('data-src');

            // İlk yarı skorları
            const halfTimeSections = document.querySelectorAll('[class*="1. yarı"], [class*="half"]');
            halfTimeSections.forEach(section => {
                const text = section.innerText || '';
                if (text.includes('1. yarı') || text.includes('Half')) {
                    const scoreMatch = text.match(/(\d+)\s*-\s*(\d+)/);
                    if (scoreMatch) {
                        result.halftime.home = parseInt(scoreMatch[1]);
                        result.halftime.away = parseInt(scoreMatch[2]);
                    }
                }
            });

            // Uzatma skorları
            const extraTimeSections = document.querySelectorAll('[class*="Uzatma"], [class*="Extra"]');
            extraTimeSections.forEach(section => {
                const text = section.innerText || '';
                const scoreMatch = text.match(/(\d+)\s*-\s*(\d+)/);
                if (scoreMatch) {
                    result.extratime.home = parseInt(scoreMatch[1]);
                    result.extratime.away = parseInt(scoreMatch[2]);
                }
            });

            // Maç olayları (goller, kartlar, değişiklikler)
            const incidents = document.querySelectorAll('.smv__incident, [class*="incident"]');
            incidents.forEach(inc => {
                const timeEl = inc.querySelector('.smv__timeBox, [class*="timeBox"]');
                const playerEl = inc.querySelector('.smv__playerName a, .smv__playerName, [class*="playerName"]');
                const isHome = inc.closest('.smv__homeParticipant') !== null;
                const isAway = inc.closest('.smv__awayParticipant') !== null;

                const time = timeEl?.textContent?.trim() || '';
                const player = playerEl?.textContent?.trim() || '';
                const type = inc.querySelector('svg[class*="goal"]') ? 'goal' :
                             inc.querySelector('svg[class*="yellowCard"]') || inc.querySelector('.yellowCard') ? 'yellow_card' :
                             inc.querySelector('svg[class*="redCard"]') || inc.querySelector('.redCard') ? 'red_card' :
                             inc.querySelector('svg[class*="substitution"]') ? 'substitution' : 'other';

                if (player && time) {
                    result.events.push({
                        type,
                        time,
                        player,
                        homeOrAway: isHome ? 'home' : (isAway ? 'away' : 'unknown')
                    });
                }
            });

            // İstatistikler
            const statRows = document.querySelectorAll('[class*="wcl-statistics"] [class*="wcl-row"], .statistics__row');
            statRows.forEach(row => {
                const homeVal = row.querySelector('[class*="homeValue"], .stat__home-value');
                const awayVal = row.querySelector('[class*="awayValue"], .stat__away-value');
                const label = row.querySelector('[class*="category"], .stat__label');

                if (homeVal && awayVal && label) {
                    result.statistics.push({
                        type: label.textContent.trim(),
                        home: homeVal.textContent.trim(),
                        away: awayVal.textContent.trim()
                    });
                }
            });

            // Hakem
            const refereeEl = document.querySelector('[class*="Hakem"], [class*="referee"]');
            if (refereeEl) {
                result.referee = refereeEl.textContent.replace('Hakem:', '').trim();
            }

            // Stat
            const venueEl = document.querySelector('[class*="Stat"], [class*="venue"]');
            if (venueEl) {
                const venueText = venueEl.textContent.replace('Stat:', '').trim();
                const parts = venueText.split(/[\(\)]/);
                result.venue.name = parts[0].trim();
                if (parts[1]) result.venue.city = parts[1].trim();
            }

            // Kapasite
            const capacityEl = document.querySelector('[class*="Kapasite"], [class*="capacity"]');
            if (capacityEl) {
                result.venue.capacity = capacityEl.textContent.replace(/[^\d]/g, '');
            }

            // Seyirci sayısı
            const attendanceEl = document.querySelector('[class*="Seyirci"], [class*="attendance"]');
            if (attendanceEl) {
                result.attendance = attendanceEl.textContent.replace(/[^\d]/g, '');
            }

            return result;
        });

        log(`    📊 Detay alındı: ${details.events.length} olay, ${details.statistics.length} istatistik`);
        return details;

    } catch (e) {
        log(`    ⚠️  Detay alınamadı: ${e.message}`);
        return null;
    }
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate, getDetails = false) {
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

    // Önce maç linklerini ve temel bilgileri al
    const matchesData = await page.evaluate((dateStr, timestamp, seasonYear) => {
        const results = [];
        let league = { id:0, name:'Unknown League', country:'Unknown' };

        const rows = document.querySelectorAll('.headerLeague, .event__header, .event__match, [id^="g_1_"]');

        rows.forEach(el => {
            const cls = (el.className?.toString() || '').toLowerCase();
            const id = el.id || '';

            const isMatch = cls.includes('match') || id.startsWith('g_1_');
            const isHeader = !isMatch && (cls.includes('headerleague') || cls.includes('event__header'));

            // Lig Başlığı
            if (isHeader) {
                const nameEl = el.querySelector('.headerLeague__title-text, .event__title--name');
                const countryEl = el.querySelector('.headerLeague__category-text, .event__title--type');

                if (nameEl) {
                    league.name = nameEl.textContent.trim();
                    league.country = countryEl ? countryEl.textContent.replace(/:/g, '').trim() : "Unknown";
                } else {
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

                if (league.name === 'Unknown League' || league.name === '') return;

                let h=0;
                for(let i=0;i<league.name.length;i++) h=league.name.charCodeAt(i)+((h<<5)-h);
                league.id = Math.abs(h);
                return;
            }

            // Maç Satırı
            if (isMatch) {
                const rawText = el.innerText || el.textContent;
                if (!rawText) return;

                const lines = rawText.split('\n').map(l=>l.trim()).filter(Boolean);
                if (lines.length < 5) return;

                const status = lines[0];
                let home=lines[1], away=lines[2], hs=lines[3], as_=lines[4];

                if (!isNaN(parseInt(away))) { away=lines[3]; hs=lines[4]; as_=lines[5]; }

                if (!hs || !as_ || hs==='-' || as_==='-' || isNaN(parseInt(hs)) || isNaN(parseInt(as_)) || !isNaN(parseInt(status.charAt(0)))) return;

                const hScore = parseInt(hs);
                const aScore = parseInt(as_);
                const matchId = id ? (parseInt(id.replace('g_1_',''),36) || Math.floor(Math.random()*1e6)) : Math.floor(Math.random()*1e6);

                // Maç linkini bul
                const linkEl = el.querySelector('a[href*="/mac/"]');
                const matchUrl = linkEl ? 'https://www.flashscore.com.tr' + linkEl.getAttribute('href') : null;

                results.push({
                    _basic: {
                        id: matchId,
                        home, away, hScore, aScore,
                        matchUrl,
                        leagueId: league.id,
                        leagueName: league.name,
                        leagueCountry: league.country
                    },
                    fixture: {
                        id: matchId, referee:null, timezone:'Europe/Istanbul',
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
                        home: { id:0, name:home, logo:null, winner: hScore>aScore ? true : (hScore===aScore ? null : false) },
                        away: { id:0, name:away, logo:null, winner: aScore>hScore ? true : (hScore===aScore ? null : false) }
                    },
                    goals: { home:hScore, away:aScore },
                    score: {
                        halftime:  { home:null, away:null },
                        fulltime:  { home:hScore, away:aScore },
                        extratime: { home:null, away:null },
                        penalty:   { home:null, away:null }
                    }
                });
            }
        });

        return results;
    }, dateStr, timestamp, seasonYear);

    // Detaylı bilgi isteniyorsa, her maça tek tek git
    if (getDetails && matchesData.length > 0) {
        log(`    🔍 ${matchesData.length} maç için detay çekiliyor...`);

        for (let i = 0; i < matchesData.length; i++) {
            const match = matchesData[i];
            if (match._basic.matchUrl) {
                log(`    📎 Maç ${i+1}/${matchesData.length}: ${match._basic.home} vs ${match._basic.away}`);
                const details = await getMatchDetails(page, match._basic.matchUrl);

                if (details) {
                    // Logoları ekle
                    match.teams.home.logo = details.homeLogo;
                    match.teams.away.logo = details.awayLogo;

                    // Skorları güncelle
                    if (details.halftime.home !== null) {
                        match.score.halftime = { home: details.halftime.home, away: details.halftime.away };
                    }
                    if (details.extratime.home !== null) {
                        match.score.extratime = { home: details.extratime.home, away: details.extratime.away };
                    }

                    // Olayları ekle (events)
                    if (details.events && details.events.length > 0) {
                        match.events = details.events;
                    }

                    // İstatistikleri ekle
                    if (details.statistics && details.statistics.length > 0) {
                        match.statistics = details.statistics;
                    }

                    // Maç bilgileri
                    if (details.referee) {
                        match.fixture.referee = details.referee;
                    }
                    if (details.venue.name) {
                        match.fixture.venue.name = details.venue.name;
                        match.fixture.venue.city = details.venue.city;
                    }
                    if (details.venue.capacity) {
                        match.fixture.venue.capacity = parseInt(details.venue.capacity);
                    }
                    if (details.attendance) {
                        match.fixture.attendance = parseInt(details.attendance);
                    }
                }

                // Rate limiting - her maçtan sonra bekle
                if (i < matchesData.length - 1) {
                    await sleep(1500);
                }
            }
        }
    }

    // Temizleme: _basic'i kaldır
    return matchesData.map(m => {
        const { _basic, ...rest } = m;
        return rest;
    });
}

// ─── FİRESTORE ─────────────────────────────────────────────────────────────
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
    const matches = await collectMatches(page, targetDate, DETAIL);
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
    page.on('request', r => ['image','font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

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
            await processDate(page, db, y);
        } else if (MODE==='single') {
            if (!SINGLE) throw new Error('--date gerekli!');
            await processDate(page, db, parseTargetDate(SINGLE));
        } else if (MODE==='backfill') {
            if (!FROM_DATE||!TO_DATE) throw new Error('--from ve --to gerekli!');
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end-start)/86400000)+1;
            log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i=0; i<total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate()+i);
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
