const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

puppeteer.use(StealthPlugin());

const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE   = args.mode || 'daily';
const SINGLE = args.date || null;

function initFirebase() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error("HATA: FIREBASE_SERVICE_ACCOUNT Secret bulunamadı!");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    return getFirestore();
}

const formatDate = (d) => d.toISOString().split('T')[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Takvim butonuna tıkla ───────────────────────────────────────────────────
async function clickYesterdayButton(page) {
    const SELECTORS = [
        '.calendar__direction--yesterday',
        '.calendar__navigation--yesterday',
        '[class*="calendar"][class*="yesterday"]',
        '[class*="calLeft"]',
        '[class*="calendar__direction--left"]',
        '[data-navigation="yesterday"]',
    ];

    for (const sel of SELECTORS) {
        try {
            await page.waitForSelector(sel, { visible: true, timeout: 3000 });
            await page.click(sel);
            console.log(`  ✅ Takvim butonu bulundu: "${sel}"`);
            return true;
        } catch (_) {}
    }

    const clicked = await page.evaluate(() => {
        const candidates = [
            ...document.querySelectorAll('[class*="calendar"] button'),
            ...document.querySelectorAll('[class*="calendar"] span'),
            ...document.querySelectorAll('[class*="calendar"] a'),
            ...document.querySelectorAll('[class*="calendar"] div[role="button"]'),
        ];
        const btn = candidates.find(el => {
            const cls  = (el.className || '').toLowerCase();
            const text = (el.innerText  || '').toLowerCase();
            return cls.includes('yesterday') || cls.includes('prev') ||
                   cls.includes('left')      || cls.includes('back') ||
                   text === '<' || text === '‹' || text === '←';
        });
        if (btn) { btn.click(); return true; }

        const arrows = [...document.querySelectorAll('[class*="calendar"] svg')];
        if (arrows.length > 0) {
            const parent = arrows[0].closest('button, a, span, div');
            if (parent) { parent.click(); return true; }
        }
        return false;
    });

    if (clicked) {
        console.log('  ✅ Takvim butonu JS fallback ile tıklandı.');
        return true;
    }
    console.log('  ⚠️  Takvim butonu hiçbir yöntemle bulunamadı.');
    return false;
}

// ─── Lig başlığını parse et ──────────────────────────────────────────────────
// Flashscore başlık formatları:
//   "TÜRKİYE: Süper Lig"          → country: TÜRKİYE, league: Süper Lig
//   "DÜNYA: FIFA Dünya Kupası"     → country: DÜNYA,   league: FIFA Dünya Kupası
//   "Süper Lig"                    → country: Unknown, league: Süper Lig
function parseLeagueHeader(rawText) {
    const text = rawText.trim();
    // "ÜLKE: Lig Adı" formatını yakala
    const colonIdx = text.indexOf(':');
    if (colonIdx > -1) {
        return {
            country: text.slice(0, colonIdx).trim(),
            name:    text.slice(colonIdx + 1).trim(),
        };
    }
    // Ayırıcı yok → tamamı lig adı
    return { country: 'Unknown', name: text };
}

// Lig adından deterministik sayısal ID üret (aynı lig → aynı ID)
function leagueHash(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
}

// ─── Maçları topla ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    // Debug: Flashscore'un gerçek başlık HTML'ini görmek için
    const headerDebug = await page.evaluate(() => {
        const headers = [...document.querySelectorAll('.event__header')].slice(0, 3);
        return headers.map(h => ({
            outerHTML: h.outerHTML.slice(0, 300),
            innerText: h.innerText.trim().slice(0, 100),
        }));
    });
    if (headerDebug.length > 0) {
        console.log('  🔍 Örnek başlık yapısı:');
        headerDebug.forEach((h, i) => {
            console.log(`     [${i}] innerText: "${h.innerText}"`);
            console.log(`     [${i}] HTML: ${h.outerHTML}`);
        });
    }

    return await page.evaluate((dateStr, timestamp, seasonYear) => {

        // ─── Lig başlığından ülke + lig adını çıkar ─────────────────────────
        function parseHeader(el) {
            // Yöntem 1: Ayrı span/div elementlerini ara
            const countryEl = el.querySelector(
                '.event__title--type, [class*="title--type"], [class*="country"]'
            );
            const leagueEl = el.querySelector(
                '.event__title--name, [class*="title--name"], [class*="league"]'
            );

            if (countryEl && leagueEl) {
                return {
                    country: countryEl.innerText.trim(),
                    name:    leagueEl.innerText.trim(),
                };
            }

            // Yöntem 2: .event__title içindeki tek text
            const titleEl = el.querySelector('.event__title, [class*="event__title"]');
            const rawText = titleEl ? titleEl.innerText.trim() : el.innerText.trim();

            // "TÜRKİYE: Süper Lig" veya "DÜNYA: FIFA Dünya Kupası"
            const colonIdx = rawText.indexOf(':');
            if (colonIdx > -1) {
                return {
                    country: rawText.slice(0, colonIdx).trim(),
                    name:    rawText.slice(colonIdx + 1).trim(),
                };
            }

            // Yöntem 3: " - " ayırıcısı (bazı dil versiyonları)
            const dashIdx = rawText.indexOf(' - ');
            if (dashIdx > -1) {
                return {
                    country: rawText.slice(0, dashIdx).trim(),
                    name:    rawText.slice(dashIdx + 3).trim(),
                };
            }

            // Fallback: Sadece lig adı var
            return { country: 'Unknown', name: rawText || 'Unknown League' };
        }

        function leagueHash(name) {
            let hash = 0;
            for (let i = 0; i < name.length; i++) {
                hash = name.charCodeAt(i) + ((hash << 5) - hash);
            }
            return Math.abs(hash);
        }

        const results = [];
        let currentLeague = { id: 0, name: 'Unknown League', country: 'Unknown' };

        // event__header ve event__match'leri sırayla işle
        const rows = document.querySelectorAll('.event__header, .event__match');

        rows.forEach(el => {
            // ── LİG BAŞLIĞI ──────────────────────────────────────────────────
            if (el.classList.contains('event__header')) {
                const parsed = parseHeader(el);
                currentLeague = {
                    id:      leagueHash(parsed.name),
                    name:    parsed.name,
                    country: parsed.country,
                };
                return; // bu element maç değil, devam
            }

            // ── MAÇ SATIRI ───────────────────────────────────────────────────
            if (!el.classList.contains('event__match')) return;

            const lines = el.innerText.split('\n').map(l => l.trim()).filter(l => l !== '');
            if (lines.length < 5) return;

            const matchStatus = lines[0];
            let homeTeam  = lines[1];
            let awayTeam  = lines[2];
            let homeScore = lines[3];
            let awayScore = lines[4];

            // Kırmızı kart/ikon kayması düzeltmesi
            if (!isNaN(parseInt(awayTeam))) {
                awayTeam  = lines[3];
                homeScore = lines[4];
                awayScore = lines[5];
            }

            // Sadece bitmiş maçlar
            const isFinished = (
                homeScore !== '-' && awayScore !== '-' &&
                homeScore !== undefined && awayScore !== undefined &&
                !isNaN(parseInt(homeScore)) && !isNaN(parseInt(awayScore)) &&
                isNaN(parseInt(matchStatus.charAt(0)))
            );
            if (!isFinished) return;

            const hScore  = parseInt(homeScore) || 0;
            const aScore  = parseInt(awayScore) || 0;
            const rawId   = el.id ? el.id.replace('g_1_', '') : '';
            const matchId = rawId
                ? (parseInt(rawId, 36) || rawId.split('').reduce((a, c) => a + c.charCodeAt(0), 0))
                : Math.floor(Math.random() * 1000000);

            results.push({
                fixture: {
                    id: matchId,
                    referee: null,
                    timezone: "Europe/Istanbul",
                    date: `${dateStr}T20:00:00+03:00`,
                    timestamp,
                    periods: { first: null, second: null },
                    venue: { id: null, name: null, city: null },
                    status: { long: "Match Finished", short: "FT", elapsed: 90, extra: null }
                },
                league: {
                    id:        currentLeague.id,
                    name:      currentLeague.name,     // ✅ Gerçek lig adı
                    country:   currentLeague.country,  // ✅ Gerçek ülke adı
                    logo:      null,
                    flag:      null,
                    season:    seasonYear,
                    round:     "Regular Season",
                    standings: false
                },
                teams: {
                    home: { id: 0, name: homeTeam, logo: null,
                            winner: hScore > aScore ? true : (hScore === aScore ? null : false) },
                    away: { id: 0, name: awayTeam, logo: null,
                            winner: aScore > hScore ? true : (hScore === aScore ? null : false) }
                },
                goals: { home: hScore, away: aScore },
                score: {
                    halftime:  { home: null,   away: null   },
                    fulltime:  { home: hScore, away: aScore },
                    extratime: { home: null,   away: null   },
                    penalty:   { home: null,   away: null   }
                }
            });
        });

        return results;
    }, dateStr, timestamp, seasonYear);
}

// ─── Firestore'a yaz ─────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    const dateRef = db.collection('archive_matches').doc(dateStr);
    await dateRef.set({
        fixtures:      matches,
        last_updated:  new Date().toISOString(),
        total_matches: matches.length
    }, { merge: true });
    console.log(`  ✅ Toplam ${matches.length} maç → archive_matches/${dateStr} belgesine yazıldı!`);

    // Hangi ligler çekildi?
    const leagues = [...new Set(matches.map(m => `${m.league.country}: ${m.league.name}`))];
    console.log(`  📋 Ligler (${leagues.length} adet): ${leagues.slice(0, 10).join(' | ')}${leagues.length > 10 ? ' ...' : ''}`);
}

// ─── Ana akış ─────────────────────────────────────────────────────────────────
(async () => {
    const db = initFirebase();
    console.log("🤖 ScorePop Botu Başlatılıyor...");

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.emulateTimezone('Europe/Istanbul');

    await page.setRequestInterception(true);
    page.on('request', req =>
        ['image', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue()
    );

    let targetDate = new Date();
    if (MODE === 'daily')            targetDate.setUTCDate(targetDate.getUTCDate() - 1);
    if (MODE === 'single' && SINGLE) targetDate = new Date(SINGLE + 'T00:00:00Z');

    const dateStr = formatDate(targetDate);
    console.log(`📅 Hedef Tarih: ${dateStr}`);
    console.log("🔍 Flashscore'a bağlanılıyor...");

    try {
        await page.goto('https://www.flashscore.com.tr/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        const title = await page.title();
        if (title.toLowerCase().includes('just a moment')) {
            console.log('🛡️  Cloudflare engeli, 20s bekleniyor...');
            await sleep(20000);
        }

        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
            await page.click('#onetrust-accept-btn-handler');
            await sleep(1000);
            console.log('🍪 Çerez kabul edildi.');
        } catch (_) {}

        console.log("🔄 Dünün sayfasına geçiliyor...");
        await sleep(2000);

        try {
            await Promise.race([
                Promise.all([
                    page.waitForResponse(
                        res => res.status() === 200 && (
                            res.url().includes('feed') ||
                            res.url().includes('flashscore') ||
                            res.url().includes('events')
                        ),
                        { timeout: 12000 }
                    ),
                    clickYesterdayButton(page)
                ]),
                sleep(8000).then(() => clickYesterdayButton(page))
            ]);
        } catch (e) {
            console.log("⚠️  Ağ bekleme başarısız, basit tıklama:", e.message);
            await clickYesterdayButton(page);
        }

        await sleep(4000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1500);

        console.log(`⚽ ${dateStr} bitmiş maçları toplanıyor...`);
        const matches = await collectMatches(page, targetDate);
        console.log(`🏆 ${matches.length} bitmiş maç bulundu.`);

        if (matches.length > 0) {
            await saveToFirestore(db, dateStr, matches);
        } else {
            console.log("  ❌ Bitmiş maç bulunamadı.");
            const count = await page.evaluate(() =>
                document.querySelectorAll('.event__match').length
            );
            console.log(`     Sayfada ${count} .event__match var (bitmemiş maçlar dahil).`);
        }

    } catch (e) {
        console.error("🔴 KRİTİK HATA:", e.message);
        process.exit(1);
    } finally {
        await browser.close();
        console.log("🏁 Operasyon tamamlandı.");
        process.exit(0);
    }
})();
