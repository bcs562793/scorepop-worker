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
const MODE         = args.mode || 'daily';
const SINGLE       = args.date || null;
const FROM_DATE    = args.from || null;
const TO_DATE      = args.to || null;
const FETCH_DETAILS = args.details === 'true' || args.details === '1';

log('🤖 ScorePop Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}${FETCH_DETAILS ? ' | Detaylar: EVET' : ''}`);
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

    await page.evaluate(async () => {
        await new Promise(r => {
            let p=0; const t = setInterval(()=>{ window.scrollBy(0,800); p+=800;
                if(p>=document.body.scrollHeight){clearInterval(t);r();} }, 200);
        });
    });
    await sleep(2000);

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

                results.push({
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

// ─── MAÇ DETAYLARINI TOPLA ─────────────────────────────────────────────────
async function collectMatchDetails(page, matchId) {
    // Maç detay sayfasına git
    const detailUrl = `https://www.flashscore.com.tr/mac/futbol/${matchId}/`;
    log(`  🔗 Detay sayfası: ${detailUrl}`);

    try {
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000); // Sayfa yüklensin

        // Çerez popup'ı varsa kabul et
        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 3000 });
            await page.click('#onetrust-accept-btn-handler');
            await sleep(500);
        } catch (_) {}

        const details = await page.evaluate((matchId) => {
            const result = {
                events: [],
                stats: {},
                info: {},
                logos: { home: null, away: null }
            };

            // ── TAKIM LOGOLARI ──
            const logoEls = document.querySelectorAll('.participant__image, .tournamentHeader .logo img, .duelParticipant img');
            logoEls.forEach((img, idx) => {
                if (img.src && img.src.includes('static.flashscore')) {
                    if (idx === 0) result.logos.home = img.src;
                    else if (idx === 1) result.logos.away = img.src;
                }
            });

            // Alternatif logo bulma
            const allLogos = document.querySelectorAll('img[src*="static.flashscore"]');
            const teamLogos = Array.from(allLogos).filter(img =>
                img.alt && img.alt.length > 0 && !img.alt.includes('logo', 0)
            );
            if (teamLogos.length >= 2) {
                result.logos.home = teamLogos[0].src;
                result.logos.away = teamLogos[1].src;
            }

            // ── MAÇ OLAYLARI (Events) ──
            // Özet sekmesi içindeki olayları bul
            const eventSections = document.querySelectorAll('.smv__verticalSections, .tabContent__match-summary, [class*="match-summary"]');

            eventSections.forEach(section => {
                const incidents = section.querySelectorAll('.smv__incident, .incident__row, [class*="incident"]');

                incidents.forEach(inc => {
                    const timeEl = inc.querySelector('.smv__timeBox, .incident__time, [class*="timeBox"]');
                    const time = timeEl ? timeEl.textContent.trim().replace("'", "") : null;

                    if (!time) return;

                    // Gol ikonu var mı?
                    const goalIcon = inc.querySelector('[class*="goal"], .incidents-goal-soccer, svg[class*="goal"]');
                    // Kart ikonu var mı?
                    const cardIcon = inc.querySelector('.card-ico, [class*="card"], svg[class*="card"]');
                    // Değişiklik ikonu var mı?
                    const subIcon = inc.querySelector('[class*="substitution"], .wcl-icon-incidents-substitution');

                    // Oyuncu ismi
                    const playerEl = inc.querySelector('.smv__playerName a, .incident__player a, [class*="playerName"] a, [class*="playerName"]');
                    const playerName = playerEl ? playerEl.textContent.trim() : null;

                    // Asist
                    const assistEl = inc.querySelector('.smv__assist, .incident__assist, [class*="assist"]');
                    const assist = assistEl ? assistEl.textContent.replace(/[()]/g, '').trim() : null;

                    // Skor (gol ise)
                    const scoreEl = inc.querySelector('.smv__incidentAwayScore, .smv__incidentHomeScore, [class*="incidentScore"]');
                    const score = scoreEl ? scoreEl.textContent.trim() : null;

                    // Takım (home/away)
                    const row = inc.closest('.smv__homeParticipant, .smv__awayParticipant, [class*="homeParticipant"], [class*="awayParticipant"]');
                    let team = 'home';
                    if (row && (row.className.includes('away') || row.className.includes('Deplasman'))) {
                        team = 'away';
                    }

                    if (goalIcon && playerName) {
                        result.events.push({
                            type: 'goal',
                            minute: parseInt(time) || time,
                            player: playerName,
                            assist: assist,
                            score: score,
                            team: team
                        });
                    } else if (cardIcon && playerName) {
                        const isRed = cardIcon.className.includes('red') || inc.innerHTML.includes('#dc0000');
                        result.events.push({
                            type: isRed ? 'redCard' : 'yellowCard',
                            minute: parseInt(time) || time,
                            player: playerName,
                            team: team
                        });
                    } else if (subIcon && playerName) {
                        // Değişiklik: Giren ve çıkan oyuncuları bul
                        const outEl = inc.querySelector('.smv__subDown, .incident__out, [class*="subDown"]');
                        const inEl = inc; // current player is the one coming in

                        result.events.push({
                            type: 'substitution',
                            minute: parseInt(time) || time,
                            playerIn: playerName,
                            playerOut: outEl ? outEl.textContent.trim() : null,
                            team: team
                        });
                    }
                });
            });

            // ── İSTATİSTİKLER ──
            const statRows = document.querySelectorAll('.wcl-row_2oCpS, .stat__row, [class*="statistics"] .row, [data-testid="wcl-statistics"]');

            statRows.forEach(row => {
                const categoryEl = row.querySelector('.wcl-category_6sT1J, .stat__category-name, [class*="category"]');
                const homeValEl = row.querySelector('.wcl-homeValue_3Q-7P, .stat__home-value, [class*="homeValue"]');
                const awayValEl = row.querySelector('.wcl-awayValue_Y-QR1, .stat__away-value, [class*="awayValue"]');

                if (categoryEl && homeValEl && awayValEl) {
                    const category = categoryEl.textContent.trim();
                    const homeVal = homeValEl.textContent.trim();
                    const awayVal = awayValEl.textContent.trim();

                    // Kategori ismine göre normalize et
                    let statKey = category.toLowerCase();

                    if (statKey.includes('topa sahip') || statKey.includes('possession')) {
                        result.stats.ballPossession = {
                            home: parseInt(homeVal) || parseInt(homeVal.replace('%', '')),
                            away: parseInt(awayVal) || parseInt(awayVal.replace('%', ''))
                        };
                    } else if (statKey.includes('gol beklentisi') || statKey.includes('xG')) {
                        result.stats.xg = {
                            home: parseFloat(homeVal),
                            away: parseFloat(awayVal)
                        };
                    } else if (statKey.includes('toplam şut') || statKey.includes('shots')) {
                        result.stats.totalShots = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('isabetli şut') || statKey.includes('shots on target')) {
                        result.stats.shotsOnTarget = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('korner') || statKey.includes('corner')) {
                        result.stats.corners = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('faul') || statKey.includes('foul')) {
                        result.stats.fouls = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('ofsayt') || statKey.includes('offside')) {
                        result.stats.offsides = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('sarı kart') || statKey.includes('yellow card')) {
                        result.stats.yellowCards = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('kırmızı kart') || statKey.includes('red card')) {
                        result.stats.redCards = {
                            home: parseInt(homeVal),
                            away: parseInt(awayVal)
                        };
                    } else if (statKey.includes('pas') || statKey.includes('pass')) {
                        result.stats.passes = {
                            home: parseInt(homeVal.replace('%', '')),
                            away: parseInt(awayVal.replace('%', ''))
                        };
                    }
                }
            });

            // ── MAÇ BİLGİLERİ ──
            const infoLabels = document.querySelectorAll('.wcl-infoLabelWrapper_DXbvw, .matchInfo__label, [class*="infoLabel"]');

            infoLabels.forEach(label => {
                const text = label.textContent.toLowerCase();
                const valueEl = label.nextElementSibling || label.parentElement?.querySelector('.wcl-infoValue_grawU, [class*="infoValue"]');
                const value = valueEl ? valueEl.textContent.trim() : null;

                if (!value) return;

                if (text.includes('hakem') || text.includes('referee')) {
                    result.info.referee = value;
                } else if (text.includes('stat') || text.includes('venue')) {
                    result.info.venue = value;
                } else if (text.includes('kapasite') || text.includes('capacity')) {
                    result.info.capacity = parseInt(value.replace(/[^0-9]/g, ''));
                } else if (text.includes('seyirci') || text.includes('attendance')) {
                    result.info.attendance = parseInt(value.replace(/[^0-9]/g, ''));
                }
            });

            // TV Kanalları
            const tvLinks = document.querySelectorAll('.wcl-tvStationLink_a38PB, a[href*="tv"], [class*="tvChannel"] a');
            if (tvLinks.length > 0) {
                result.info.tvChannels = Array.from(tvLinks).map(a => ({
                    name: a.textContent.trim(),
                    url: a.href
                }));
            }

            return result;
        }, matchId);

        log(`  ✓ Events: ${details.events.length}, Stats: ${Object.keys(details.stats).length}, Info keys: ${Object.keys(details.info).length}`);
        return details;

    } catch (e) {
        log(`  ⚠️ Detay alınamadı: ${e.message}`);
        return null;
    }
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
async function processDate(page, db, targetDate, fetchDetails = false) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);
    await navigateToDate(page, targetDate);
    log('⚽ Maçlar toplanıyor...');
    const matches = await collectMatches(page, targetDate);
    log(`🏆 ${matches.length} bitmiş maç.`);

    // Detaylı maç bilgileri isteniyorsa (--details flag ile)
    if (fetchDetails && matches.length > 0) {
        log(`🔍 Maç detayları çekiliyor (${matches.length} maç)...`);

        // Her maç için detay sayfasına git
        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const matchId = match.fixture?.id || match.id;

            if (!matchId) {
                log(`  ⚠️ Maç ID yok, detay atlanıyor: ${i + 1}/${matches.length}`);
                continue;
            }

            log(`  📥 Maç ${i + 1}/${matches.length}: ${match.teams?.home?.name} vs ${match.teams?.away?.name}`);

            try {
                const details = await collectMatchDetails(page, matchId);
                if (details) {
                    // Detayları match objesine ekle
                    match.details = details;

                    // Takım logolarını güncelle
                    if (details.logos?.home) {
                        if (!match.teams) match.teams = {};
                        if (!match.teams.home) match.teams.home = {};
                        match.teams.home.logo = details.logos.home;
                    }
                    if (details.logos?.away) {
                        if (!match.teams) match.teams = {};
                        if (!match.teams.away) match.teams.away = {};
                        match.teams.away.logo = details.logos.away;
                    }
                }
            } catch (e) {
                log(`  ⚠️ Detay hatası: ${e.message}`);
            }

            // Anti-ban: Rastgele bekleme
            const waitTime = 1500 + Math.random() * 2000;
            await sleep(waitTime);
        }
        log(`✅ Tüm maç detayları tamamlandı.`);
    }

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
            await processDate(page, db, y, FETCH_DETAILS);
        } else if (MODE==='single') {
            if (!SINGLE) throw new Error('--date gerekli!');
            await processDate(page, db, parseTargetDate(SINGLE), FETCH_DETAILS);
        } else if (MODE==='backfill') {
            if (!FROM_DATE||!TO_DATE) throw new Error('--from ve --to gerekli!');
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end-start)/86400000)+1;
            log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i=0; i<total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate()+i);
                await processDate(page, db, d, FETCH_DETAILS);
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
