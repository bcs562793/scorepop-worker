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

// ─── Takvim butonuna tıkla (çoklu selector denemesi) ────────────────────────
// Flashscore zaman zaman bu class ismini değiştiriyor.
// Tüm olası isimleri sırayla deniyoruz, biri çalışınca duruyoruz.
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

    // Selector'lar başarısız → sayfadaki tüm butonları tara
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

        // Son çare: SVG ok içeren elementler
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

// ─── Maçları topla ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr = formatDate(targetDate);
    const timestamp = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    return await page.evaluate((dateStr, timestamp, seasonYear) => {
        const results = [];
        // KRİTİK DEĞİŞİKLİK: Sadece maçları değil, Lig Başlıklarını da seçiyoruz!
        const rows = document.querySelectorAll('.event__header, .event__match');
        
        let currentLeagueName = "Unknown League";
        let currentCountryName = "Unknown";
        let currentLeagueId = Math.floor(Math.random() * 1000); // Geçici ID

        rows.forEach(el => {
            // 1. EĞER BU SATIR BİR LİG BAŞLIĞIYSA: Hafızadaki ligi güncelle
            if (el.classList.contains('event__header')) {
                const countryEl = el.querySelector('.event__title--type');
                const leagueEl = el.querySelector('.event__title--name');
                
                if (leagueEl) {
                    currentLeagueName = leagueEl.innerText.trim();
                    currentCountryName = countryEl ? countryEl.innerText.trim() : "Unknown";
                    // Lig adından basit bir sayısal ID üretelim (Aynı liglerin ID'si aynı olsun diye)
                    let hash = 0;
                    for (let i = 0; i < currentLeagueName.length; i++) {
                        hash = currentLeagueName.charCodeAt(i) + ((hash << 5) - hash);
                    }
                    currentLeagueId = Math.abs(hash);
                }
            } 
            // 2. EĞER BU SATIR BİR MAÇSA: Hafızadaki lig bilgisiyle maçı kaydet
            else if (el.classList.contains('event__match')) {
                const rawText = el.innerText;
                const lines = rawText.split('\n').map(l => l.trim()).filter(l => l !== '');
                
                if (lines.length >= 5) {
                    const matchStatus = lines[0];
                    let homeTeam = lines[1];
                    let awayTeam = lines[2];
                    let homeScore = lines[3];
                    let awayScore = lines[4];

                    if (!isNaN(parseInt(awayTeam))) {
                        awayTeam = lines[3];
                        homeScore = lines[4];
                        awayScore = lines[5];
                    }

                    if (homeScore !== "-" && awayScore !== "-" && isNaN(parseInt(matchStatus.charAt(0)))) {
                        const hScore = parseInt(homeScore) || 0;
                        const aScore = parseInt(awayScore) || 0;
                        const matchId = el.id ? parseInt(el.id.replace('g_1_', ''), 36) || Math.floor(Math.random() * 1000000) : Math.floor(Math.random() * 1000000);
                        
                        results.push({
                            fixture: {
                                id: matchId,
                                referee: null,
                                timezone: "Europe/Istanbul",
                                date: `${dateStr}T20:00:00+03:00`,
                                timestamp: timestamp,
                                periods: { first: null, second: null },
                                venue: { id: null, name: null, city: null },
                                status: { long: "Match Finished", short: "FT", elapsed: 90, extra: null }
                            },
                            league: {
                                id: currentLeagueId, // Artık dinamik!
                                name: currentLeagueName, // Artık Scraped League değil, gerçek lig adı!
                                country: currentCountryName,
                                logo: null,
                                flag: null,
                                season: seasonYear,
                                round: "Regular Season",
                                standings: false
                            },
                            teams: {
                                home: { id: 0, name: homeTeam, logo: null, winner: hScore > aScore ? true : (hScore === aScore ? null : false) },
                                away: { id: 0, name: awayTeam, logo: null, winner: aScore > hScore ? true : (hScore === aScore ? null : false) }
                            },
                            goals: { home: hScore, away: aScore },
                            score: {
                                halftime: { home: null, away: null },
                                fulltime: { home: hScore, away: aScore },
                                extratime: { home: null, away: null },
                                penalty: { home: null, away: null }
                            }
                        });
                    }
                }
            }
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

    // ✅ Log artık gerçek Firestore yolunu gösteriyor
    console.log(`  ✅ Toplam ${matches.length} maç → archive_matches/${dateStr} belgesine yazıldı!`);
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

    // Görselleri engelle (hız için)
    await page.setRequestInterception(true);
    page.on('request', req =>
        ['image', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue()
    );

    // Hedef tarihi hesapla
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

        // Cloudflare kontrolü
        const title = await page.title();
        if (title.toLowerCase().includes('just a moment')) {
            console.log('🛡️  Cloudflare engeli, 20s bekleniyor...');
            await sleep(20000);
        }

        // Çerez popup
        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
            await page.click('#onetrust-accept-btn-handler');
            await sleep(1000);
            console.log('🍪 Çerez kabul edildi.');
        } catch (_) {}

        // ─── Dünün sayfasına git ─────────────────────────────────────────────
        console.log("🔄 Dünün sayfasına geçiliyor...");
        await sleep(2000); // Sayfa render'ını bekle

        // ✅ FIX: waitForResponse artık daha geniş URL kalıbı arıyor
        // Ağ isteği gelirse hızlı, gelmezse 8s sonra devam
        try {
            await Promise.race([
                // A: Ağ yanıtı ile birlikte tıkla
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
                // B: 8s timeout → sadece tıkla
                sleep(8000).then(() => clickYesterdayButton(page))
            ]);
        } catch (e) {
            console.log("⚠️  Ağ bekleme başarısız, basit tıklama:", e.message);
            await clickYesterdayButton(page);
        }

        await sleep(4000); // Veri yüklenmesini bekle

        // Scroll → lazy-load tetikle
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1500);

        // ─── Maçları topla ───────────────────────────────────────────────────
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
            console.log(`     Sayfada ${count} .event__match elementi var (bitmemiş maçlar dahil).`);
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
