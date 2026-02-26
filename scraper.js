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

    return await page.evaluate((dateStr, timestamp) => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            // İŞTE ÇALIŞAN ESKİ MANTIK: Doğrudan metni satır satır bölüyoruz
            const rawText = el.innerText;
            const lines = rawText.split('\n').map(l => l.trim()).filter(l => l !== '');
            
            if (lines.length >= 5) {
                const status = lines[0];
                let homeTeam = lines[1];
                let awayTeam = lines[2];
                let homeScore = lines[3];
                let awayScore = lines[4];

                // Kırmızı kart veya kart simgesi araya girerse satırlar kayar, onu düzeltiyoruz
                if (!isNaN(parseInt(awayTeam))) {
                    awayTeam = lines[3];
                    homeScore = lines[4];
                    awayScore = lines[5];
                }

                // Saat içermiyorsa (yani oynanmışsa/oynanıyorsa) ve skoru varsa al
                if (homeScore !== "-" && !status.includes(':')) {
                    const hScore = parseInt(homeScore) || 0;
                    const aScore = parseInt(awayScore) || 0;
                    
                    // Flashscore ID'sini al, yoksa rastgele at
                    const matchId = el.id ? parseInt(el.id.replace('g_1_', ''), 36) || Math.floor(Math.random() * 1000000) : Math.floor(Math.random() * 1000000);
                    
                    // 🔥 SCOREPOP API-FOOTBALL V3 ŞEMASI 🔥
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

// 🔥 matches -> games ALT KOLEKSİYONUNA YAZMA 🔥
async function saveToFirestore(db, dateStr, matches) {
    const batch = db.batch();
    const dateRef = db.collection('matches').doc(dateStr);

    batch.set(dateRef, { 
        date: dateStr,
        total_matches: matches.length,
        last_updated: new Date().toISOString()
    }, { merge: true });

    matches.forEach(match => {
        const gameRef = dateRef.collection('games').doc(String(match.fixture.id));
        batch.set(gameRef, match, { merge: true });
    });

    await batch.commit();
    console.log(`  ✅ ${matches.length} maç matches/${dateStr}/games yoluna yazıldı!`);
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
    if (MODE === 'single' && SINGLE) targetDate = new Date(SINGLE);

    const dateStr = formatDate(targetDate);
    console.log(`📅 İşlem Tarihi: ${dateStr}`);

    try {
        await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 3000 });
            await page.click('#onetrust-accept-btn-handler');
            await sleep(1000);
        } catch(e) {}

        try {
            await page.waitForSelector('.calendar__direction--yesterday', { timeout: 5000 });
            await page.click('.calendar__direction--yesterday');
            await sleep(5000);
        } catch(e) { console.log("⚠️ Tarih navigasyonu yapılamadı."); }

        const matches = await collectMatches(page, targetDate);

        if (matches.length > 0) {
            await saveToFirestore(db, dateStr, matches);
        } else {
            console.log("  ❌ İşlenecek bitmiş maç bulunamadı.");
        }
    } catch (e) {
        console.error("🔴 HATA:", e.message);
    } finally {
        await browser.close();
        process.exit();
    }
})();
