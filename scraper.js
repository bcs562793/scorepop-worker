const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

puppeteer.use(StealthPlugin());

const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE      = args.mode || 'daily';
const SINGLE    = args.date || null;
const FROM_DATE = args.from || null;
const TO_DATE   = args.to   || null;

function initFirebase() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT)
        throw new Error("HATA: FIREBASE_SERVICE_ACCOUNT Secret bulunamadı!");
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    return getFirestore();
}

const formatDate = (d) => d.toISOString().split('T')[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── TARİH HESAPLAMA ─────────────────────────────────────────────────────────
// ✅ FIX: UTC yerine TR saatiyle "dün" hesaplanıyor
// GitHub Actions UTC çalışır. Saat 01:30 UTC = 04:30 TR.
// Türkiye UTC+3 olduğu için "dün" = UTC'nin bir gün eksiği değil,
// TR takviminin bir önceki günü demektir.
function getYesterday() {
    // TR saat dilimiyle bugünün tarihini al
    const trNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
    trNow.setDate(trNow.getDate() - 1);
    // YYYY-MM-DD formatında string olarak döndür, sonra UTC'de parse et
    const yyyy = trNow.getFullYear();
    const mm   = String(trNow.getMonth() + 1).padStart(2, '0');
    const dd   = String(trNow.getDate()).padStart(2, '0');
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
}

function parseTargetDate(dateStr) {
    return new Date(`${dateStr}T00:00:00Z`);
}

// Bugünden kaç gün önce/sonra?
function getDiffFromToday(targetDate) {
    const trNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
    const today = new Date(`${trNow.getFullYear()}-${String(trNow.getMonth()+1).padStart(2,'0')}-${String(trNow.getDate()).padStart(2,'0')}T00:00:00Z`);
    return Math.round((today - targetDate) / 86400000);
}

// ─── TAKVİM OKU ──────────────────────────────────────────────────────────────
async function clickCalendarArrow(page, direction) {
    const selectors = direction === 'left'
        ? ['.calendar__direction--yesterday', '.calendar__navigation--yesterday',
           '[class*="calendar"][class*="yesterday"]', '[class*="calLeft"]']
        : ['.calendar__direction--tomorrow', '.calendar__navigation--tomorrow',
           '[class*="calendar"][class*="tomorrow"]', '[class*="calRight"]'];

    for (const sel of selectors) {
        try {
            await page.waitForSelector(sel, { visible: true, timeout: 2000 });
            await page.click(sel);
            return true;
        } catch (_) {}
    }

    return await page.evaluate((dir) => {
        const keywords = dir === 'left'
            ? ['yesterday', 'prev', 'left', 'back']
            : ['tomorrow',  'next', 'right', 'forward'];
        const all = [
            ...document.querySelectorAll('[class*="calendar"] button'),
            ...document.querySelectorAll('[class*="calendar"] span'),
            ...document.querySelectorAll('[class*="calendar"] a'),
        ];
        const btn = all.find(el => keywords.some(k => (el.className||'').toLowerCase().includes(k)));
        if (btn) { btn.click(); return true; }
        const svgs = [...document.querySelectorAll('[class*="calendar"] svg')];
        const idx  = dir === 'left' ? 0 : svgs.length - 1;
        if (svgs[idx]) {
            const p = svgs[idx].closest('button,a,span,div');
            if (p) { p.click(); return true; }
        }
        return false;
    }, direction);
}

// ─── SAYFADA DOĞRU TARİHE GİT ────────────────────────────────────────────────
async function navigateToDate(page, targetDate) {
    const diff    = getDiffFromToday(targetDate);
    const dateStr = formatDate(targetDate);
    console.log(`  📅 Hedef: ${dateStr} | Bugünden ${diff} gün önce`);

    if (diff === 0) { console.log('  ➡️  Bugün, navigasyon gerekmiyor.'); return; }

    const dir   = diff > 0 ? 'left' : 'right';
    const steps = Math.abs(diff);

    for (let i = 0; i < steps; i++) {
        if (i === 0) {
            // İlk tıklamada ağ yanıtını bekle
            try {
                await Promise.race([
                    Promise.all([
                        page.waitForResponse(
                            r => r.status() === 200 &&
                                (r.url().includes('feed') || r.url().includes('flashscore') || r.url().includes('event')),
                            { timeout: 10000 }
                        ),
                        clickCalendarArrow(page, dir)
                    ]),
                    sleep(6000).then(() => clickCalendarArrow(page, dir))
                ]);
            } catch (_) { await clickCalendarArrow(page, dir); }
            await sleep(3000);
        } else {
            await clickCalendarArrow(page, dir);
            await sleep(700);
            if ((i + 1) % 10 === 0) { console.log(`     ${i+1}/${steps}...`); await sleep(1500); }
        }
    }

    await sleep(3000);
    console.log(`  ✅ ${dateStr} sayfasına ulaşıldı.`);
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    // ── ADIM 1: Ham HTML'i konsola yaz (lig sorununu debug etmek için) ────────
    const debugInfo = await page.evaluate(() => {
        const headers = [...document.querySelectorAll('.event__header')];
        return {
            headerCount: headers.length,
            // İlk 5 başlığın tüm text ve class bilgisi
            samples: headers.slice(0, 5).map(h => ({
                className:   h.className,
                innerText:   h.innerText.trim().replace(/\s+/g, ' ').slice(0, 150),
                // Tüm child elementlerin class + text'i
                children: [...h.querySelectorAll('*')].map(c => ({
                    tag:       c.tagName,
                    className: c.className,
                    text:      c.innerText?.trim().slice(0, 80) || '',
                })).filter(c => c.text),
            })),
        };
    });

    console.log(`\n  🔍 DEBUG: ${debugInfo.headerCount} adet .event__header bulundu`);
    debugInfo.samples.forEach((s, i) => {
        console.log(`  [${i}] innerText: "${s.innerText}"`);
        s.children.forEach(c => console.log(`       <${c.tag} class="${c.className}"> "${c.text}"`));
    });
    console.log('');

    // ── ADIM 2: Scroll ile lazy-load tetikle ──────────────────────────────────
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let pos = 0;
            const t = setInterval(() => {
                window.scrollBy(0, 400); pos += 400;
                if (pos >= document.body.scrollHeight) { clearInterval(t); resolve(); }
            }, 150);
        });
    });
    await sleep(1500);

    // ── ADIM 3: Maçları çek ───────────────────────────────────────────────────
    return await page.evaluate((dateStr, timestamp, seasonYear) => {

        // Lig başlığını parse et — tüm olası formatları dene
        function parseHeader(el) {
            // Deneme 1: Ayrı type + name span'ları
            const typeEl = el.querySelector('[class*="type"], [class*="country"], [class*="flag"]');
            const nameEl = el.querySelector('[class*="name"], [class*="league"], [class*="title--name"]');
            if (typeEl && nameEl && typeEl !== nameEl) {
                return { country: typeEl.innerText.trim(), name: nameEl.innerText.trim() };
            }

            // Deneme 2: Tüm span/div child'larını birleştir
            const children = [...el.querySelectorAll('span, a, strong')].map(c => c.innerText.trim()).filter(Boolean);
            if (children.length >= 2) {
                return { country: children[0], name: children.slice(1).join(' ') };
            }

            // Deneme 3: innerText'i ":" ile böl
            const raw = el.innerText.trim().replace(/\s+/g, ' ');
            const ci  = raw.indexOf(':');
            if (ci > -1) return { country: raw.slice(0, ci).trim(), name: raw.slice(ci + 1).trim() };

            // Deneme 4: " - " ayırıcısı
            const di = raw.indexOf(' - ');
            if (di > -1) return { country: raw.slice(0, di).trim(), name: raw.slice(di + 3).trim() };

            // Son çare
            return { country: 'Unknown', name: raw || 'Unknown League' };
        }

        function leagueHash(name) {
            let h = 0;
            for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
            return Math.abs(h);
        }

        const results = [];
        let league = { id: 0, name: 'Unknown League', country: 'Unknown' };

        document.querySelectorAll('.event__header, .event__match').forEach(el => {

            // ── LİG BAŞLIĞI ──
            if (el.classList.contains('event__header')) {
                const p = parseHeader(el);
                league  = { id: leagueHash(p.name), name: p.name, country: p.country };
                return;
            }

            // ── MAÇ SATIRI ──
            if (!el.classList.contains('event__match')) return;

            const lines = el.innerText.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 5) return;

            const status  = lines[0];
            let home      = lines[1];
            let away      = lines[2];
            let homeScore = lines[3];
            let awayScore = lines[4];

            // Kırmızı kart/ikon kayması
            if (!isNaN(parseInt(away))) { away = lines[3]; homeScore = lines[4]; awayScore = lines[5]; }

            const finished = (
                homeScore !== '-' && awayScore !== '-' &&
                !isNaN(parseInt(homeScore)) && !isNaN(parseInt(awayScore)) &&
                isNaN(parseInt(status.charAt(0)))
            );
            if (!finished) return;

            const h  = parseInt(homeScore) || 0;
            const a  = parseInt(awayScore) || 0;
            const id = el.id
                ? (parseInt(el.id.replace('g_1_',''), 36) || el.id.replace('g_1_','').split('').reduce((s,c) => s + c.charCodeAt(0), 0))
                : Math.floor(Math.random() * 1e6);

            results.push({
                fixture: {
                    id, referee: null, timezone: 'Europe/Istanbul',
                    date: `${dateStr}T20:00:00+03:00`, timestamp,
                    periods: { first: null, second: null },
                    venue: { id: null, name: null, city: null },
                    status: { long: 'Match Finished', short: 'FT', elapsed: 90, extra: null }
                },
                league: {
                    id: league.id, name: league.name, country: league.country,
                    logo: null, flag: null, season: seasonYear, round: 'Regular Season', standings: false
                },
                teams: {
                    home: { id: 0, name: home, logo: null, winner: h > a ? true : (h === a ? null : false) },
                    away: { id: 0, name: away, logo: null, winner: a > h ? true : (h === a ? null : false) }
                },
                goals: { home: h, away: a },
                score: {
                    halftime:  { home: null, away: null },
                    fulltime:  { home: h, away: a },
                    extratime: { home: null, away: null },
                    penalty:   { home: null, away: null }
                }
            });
        });

        return results;
    }, dateStr, timestamp, seasonYear);
}

// ─── FİRESTORE'A YAZ ─────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    await db.collection('archive_matches').doc(dateStr).set({
        fixtures:      matches,
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
    }, { merge: true });

    console.log(`  ✅ ${matches.length} maç → archive_matches/${dateStr} ✔`);
    const leagues = [...new Set(matches.map(m => `${m.league.country}: ${m.league.name}`))];
    console.log(`  📋 ${leagues.length} lig: ${leagues.slice(0, 8).join(' | ')}${leagues.length > 8 ? ' ...' : ''}`);
}

// ─── TEK GÜN ─────────────────────────────────────────────────────────────────
async function processDate(page, db, targetDate) {
    const dateStr = formatDate(targetDate);
    console.log(`\n📆 İşleniyor: ${dateStr}`);

    await navigateToDate(page, targetDate);

    console.log('⚽ Bitmiş maçlar toplanıyor...');
    const matches = await collectMatches(page, targetDate);
    console.log(`🏆 ${matches.length} bitmiş maç bulundu.`);

    if (matches.length > 0) {
        await saveToFirestore(db, dateStr, matches);
    } else {
        const count = await page.evaluate(() => document.querySelectorAll('.event__match').length);
        console.log(`  ❌ Bitmiş maç yok. (Sayfada ${count} .event__match var)`);
    }
}

// ─── ANA AKIŞ ─────────────────────────────────────────────────────────────────
(async () => {
    const db = initFirebase();
    console.log('🤖 ScorePop Botu Başlatılıyor...');
    console.log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
               '--disable-gpu','--window-size=1920,1080','--disable-blink-features=AutomationControlled'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.emulateTimezone('Europe/Istanbul');
    await page.setRequestInterception(true);
    page.on('request', r => ['image','font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

    console.log("🔍 Flashscore'a bağlanılıyor...");
    try {
        await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (_) { console.log('⚠️ Yükleme timeout, devam...'); }

    if ((await page.title()).toLowerCase().includes('just a moment')) {
        console.log('🛡️ Cloudflare engeli, 20s bekleniyor...'); await sleep(20000);
    }
    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler'); await sleep(1000);
        console.log('🍪 Çerez kabul edildi.');
    } catch (_) {}
    await sleep(2000);

    try {
        if (MODE === 'daily') {
            const yesterday = getYesterday();
            console.log(`📅 Dün (TR saatine göre): ${formatDate(yesterday)}`);
            await processDate(page, db, yesterday);

        } else if (MODE === 'single') {
            if (!SINGLE) throw new Error('--date parametresi gerekli! Örn: --date=2026-02-26');
            await processDate(page, db, parseTargetDate(SINGLE));

        } else if (MODE === 'backfill') {
            if (!FROM_DATE || !TO_DATE) throw new Error('--from ve --to gerekli!');
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end - start) / 86400000) + 1;
            console.log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i = 0; i < total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate() + i);
                await processDate(page, db, d);
                if (i < total - 1) { const w = 3000 + Math.random() * 2000; await sleep(w); }
            }
        }
    } catch (e) {
        console.error('🔴 KRİTİK HATA:', e.message);
        await browser.close(); process.exit(1);
    }

    await browser.close();
    console.log('\n🏁 Operasyon tamamlandı.');
    process.exit(0);
})();
