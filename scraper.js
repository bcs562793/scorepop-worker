const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

puppeteer.use(StealthPlugin());

// Argümanları al (--mode=daily veya --mode=backfill)
const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE = args.mode || 'daily';

function initFirebase() {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    return getFirestore();
}

const formatDate = (d) => d.toISOString().split('T')[0];

async function scrapeFlashscore(page, targetDate) {
    const dateStr = formatDate(targetDate);
    const timestamp = Math.floor(targetDate.getTime() / 1000);

    return await page.evaluate((dateStr, timestamp) => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            const lines = el.innerText.split('\n').map(l => l.trim()).filter(l => l !== '');
            // [0]Durum/Saat, [1]Ev, [2]Dep, [3]Ev Skor, [4]Dep Skor (Veya tam tersi yapı)
            
            if (lines.length >= 5) {
                const homeTeam = lines[1];
                const awayTeam = lines[2];
                const hScore = parseInt(lines[3]);
                const aScore = parseInt(lines[4]);

                if (!isNaN(hScore)) {
                    const matchId = el.id ? parseInt(el.id.replace('g_1_', '')) : Math.floor(Math.random() * 1000000);
                    
                    // 🔥 SCOREPOP TAM UYUMLU JSON YAPISI 🔥
                    results.push({
                        fixture: {
                            id: matchId,
                            referee: null,
                            timezone: "Europe/Istanbul",
                            date: `${dateStr}T00:00:00+03:00`,
                            timestamp: timestamp,
                            periods: { first: null, second: null },
                            venue: { id: null, name: null, city: null },
                            status: { long: "Match Finished", short: "FT", elapsed: 90, extra: null }
                        },
                        league: {
                            id: 0,
                            name: "Scraped League",
                            country: "Unknown",
                            logo: null,
                            flag: null,
                            season: 2026,
                            round: "Regular Season",
                            standings: true
                        },
                        teams: {
                            home: { id: 0, name: homeTeam, logo: null, winner: hScore > aScore },
                            away: { id: 0, name: awayTeam, logo: null, winner: aScore > hScore }
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
    }, dateStr, timestamp);
}

(async () => {
    const db = initFirebase();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    let targetDate = new Date();
    if (MODE === 'daily') targetDate.setDate(targetDate.getDate() - 1);

    const dateStr = formatDate(targetDate);
    console.log(`📅 İşlem Tarihi: ${dateStr}`);

    try {
        await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2' });
        
        // "Dün" butonuna bas ve verileri çek
        try {
            await page.waitForSelector('.calendar__direction--yesterday', { timeout: 5000 });
            await page.click('.calendar__direction--yesterday');
            await new Promise(r => setTimeout(r, 5000));
        } catch(e) { console.log("⚠️ Tarih navigasyonu yapılamadı."); }

        const fixtures = await scrapeFlashscore(page, targetDate);

        if (fixtures.length > 0) {
            // 🔥 SCOREPOP KRİTİK NOKTA: archive_matches içinde 'fixtures' array'i olarak yaz 🔥
            await db.collection('archive_matches').doc(dateStr).set({
                fixtures: fixtures,
                last_updated: new Date().toISOString()
            });
            console.log(`✅ ${fixtures.length} maç başarıyla ScorePop formatında kaydedildi!`);
        }
    } catch (e) {
        console.error("🔴 HATA:", e.message);
    } finally {
        await browser.close();
        process.exit();
    }
})();
