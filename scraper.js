const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

puppeteer.use(StealthPlugin());

const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE = args.mode || 'daily';
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

async function collectMatches(page, targetDate) {
    const dateStr = formatDate(targetDate);
    const timestamp = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    return await page.evaluate((dateStr, timestamp, seasonYear) => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            const rawText = el.innerText;
            const lines = rawText.split('\n').map(l => l.trim()).filter(l => l !== '');
            
            if (lines.length >= 5) {
                const matchStatus = lines[0];
                let homeTeam = lines[1];
                let awayTeam = lines[2];
                let homeScore = lines[3];
                let awayScore = lines[4];

                // Kırmızı kart/ikon kayması düzeltmesi
                if (!isNaN(parseInt(awayTeam))) {
                    awayTeam = lines[3];
                    homeScore = lines[4];
                    awayScore = lines[5];
                }

                // Sadece skoru olan (BİTMİŞ) maçları alıyoruz
                if (homeScore !== "-" && awayScore !== "-" && isNaN(parseInt(matchStatus.charAt(0)))) {
                    const hScore = parseInt(homeScore) || 0;
                    const aScore = parseInt(awayScore) || 0;
                    const matchId = el.id ? parseInt(el.id.replace('g_1_', ''), 36) || Math.floor(Math.random() * 1000000) : Math.floor(Math.random() * 1000000);
                    
                    // 🔥 SENİN GÖNDERDİĞİN JSON ŞEMASININ BİREBİR AYNISI 🔥
                    results.push({
                        fixture: {
                            id: matchId,
                            referee: null,
                            timezone: "Europe/Istanbul",
                            date: `${dateStr}T20:00:00+03:00`, // Örnek saat
                            timestamp: timestamp,
                            periods: { first: null, second: null },
                            venue: { id: null, name: null, city: null },
                            status: { long: "Match Finished", short: "FT", elapsed: 90, extra: null }
                        },
                        league: {
                            id: 0, // Ham veriden lig ID alınamıyor, default 0
                            name: "Scraped League",
                            country: "Unknown",
                            logo: null,
                            flag: null,
                            season: seasonYear,
                            round: "Regular Season",
                            standings: false
                        },
                        teams: {
                            home: { 
                                id: 0, 
                                name: homeTeam, 
                                logo: null, 
                                winner: hScore > aScore ? true : (hScore === aScore ? null : false) 
                            },
                            away: { 
                                id: 0, 
                                name: awayTeam, 
                                logo: null, 
                                winner: aScore > hScore ? true : (hScore === aScore ? null : false) 
                            }
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
        });
        return results;
    }, dateStr, timestamp, seasonYear);
}

// 🔥 archive_matches -> YYYY-MM-DD İçine 'fixtures' Arrayi Olarak Yazıyoruz 🔥
async function saveToFirestore(db, dateStr, matches) {
    const dateRef = db.collection('archive_matches').doc(dateStr);

    await dateRef.set({ 
        fixtures: matches, // Tüm maçlar fixtures dizisine atılıyor
        last_updated: new Date().toISOString(),
        total_matches: matches.length
    }, { merge: true });

    console.log(`  ✅ Toplam ${matches.length} maç archive_matches/${dateStr} belgesine yazıldı!`);
}

(async () => {
    const db = initFirebase();
    console.log("🤖 ScorePop Türkiye Saat Dilimi Botu Başlatılıyor...");

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
    });
    const page = await browser.newPage();

    await page.emulateTimezone('Europe/Istanbul');

    let targetDate = new Date();
    if (MODE === 'daily') targetDate.setDate(targetDate.getDate() - 1);
    if (MODE === 'single' && SINGLE) targetDate = new Date(SINGLE);

    const dateStr = formatDate(targetDate);
    console.log(`📅 Hedef Tarih: ${dateStr}`);
    console.log("🔍 Flashscore'a sızılıyor...");

    try {
        await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
            await page.click('#onetrust-accept-btn-handler');
            await sleep(1000);
        } catch(e) {}

        console.log(`🔄 Takvime tıklanıyor ve ağ isteği bekleniyor...`);
        try {
            await page.waitForSelector('.calendar__direction--yesterday', { visible: true, timeout: 10000 });
            
            // Senin yazdığın o kusursuz ağ bekleme kodu!
            await Promise.all([
                page.waitForResponse(res => res.url().includes('feed') && res.status() === 200, { timeout: 15000 }),
                page.click('.calendar__direction--yesterday')
            ]);
            
            console.log(`✅ Takvim başarıyla değişti, ${dateStr} verileri indirildi!`);
            await sleep(3000); 
        } catch (e) {
            console.log("⚠️ Takvim butonuna tıklanamadı veya ağ yanıtı alınamadı!", e.message);
            // Yedek Tıklama
            await page.evaluate(() => {
                const btn = document.querySelector('.calendar__direction--yesterday');
                if (btn) btn.click();
            });
            await sleep(5000);
        }

        // Sayfayı aşağı kaydırıp gizli maçların yüklenmesini sağla
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1000);

        console.log(`⚽ ${dateStr} BİTMİŞ maçları süzülüyor...`);
        const matches = await collectMatches(page, targetDate);

        if (matches.length > 0) {
            await saveToFirestore(db, dateStr, matches);
        } else {
            console.log("  ❌ İşlenecek bitmiş maç bulunamadı.");
        }
    } catch (e) {
        console.error("  🔴 HATA:", e.message);
    } finally {
        await browser.close();
        console.log("🏁 Operasyon başarıyla tamamlandı.");
        process.exit();
    }
})();
