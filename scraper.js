/**
 * ScorePop - Flashscore → Firestore (Api-Football Format)
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

puppeteer.use(StealthPlugin());

// --- Argümanları parse et ---
const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE = args.mode || 'daily';
const FROM_DATE = args.from || null;
const TO_DATE = args.to || null;
const SINGLE = args.date || null;

// --- Firebase Başlat ---
function initFirebase() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error("HATA: FIREBASE_SERVICE_ACCOUNT Secret eklenmemiş!");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    return getFirestore();
}

// --- Yardımcı Fonksiyonlar ---
const formatDate = (d) => d.toISOString().split('T')[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Ana Kazıma Fonksiyonu (KIRILMAZ METOT) ---
async function collectMatches(page, targetDate) {
    const dateStr = formatDate(targetDate);
    console.log(`  🔍 ${dateStr} verileri ham metin üzerinden toplanıyor...`);

    return await page.evaluate((dateStr) => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            const rawText = el.innerText;
            const lines = rawText.split('\n').map(l => l.trim()).filter(l => l !== '');
            
            // Satır yapısı: [0]Durum/Saat, [1]Ev Sahibi, [2]Deplasman, [3]Ev Skor, [4]Dep Skor
            if (lines.length >= 5) {
                const status = lines[0];
                const homeTeam = lines[1];
                const awayTeam = lines[2];
                const homeScore = lines[3];
                const awayScore = lines[4];

                // Sadece bitmiş veya skorlu maçları al
                if (homeScore !== "-" && !status.includes(':')) {
                    const matchId = el.id ? el.id.replace('g_1_', '') : Math.random().toString(36).substr(2, 9);
                    
                    // 🔥 API-FOOTBALL FORMATINA DÖNÜŞTÜRME BURADA YAPILIYOR 🔥
                    results.push({
                        fixture: {
                            id: matchId,
                            date: dateStr,
                            status: { long: "Match Finished", short: "FT" }
                        },
                        teams: {
                            home: { name: homeTeam, winner: parseInt(homeScore) > parseInt(awayScore) },
                            away: { name: awayTeam, winner: parseInt(awayScore) > parseInt(homeScore) }
                        },
                        goals: {
                            home: parseInt(homeScore),
                            away: parseInt(awayScore)
                        },
                        score: {
                            fulltime: { home: parseInt(homeScore), away: parseInt(awayScore) }
                        },
                        // Uygulaman için ekstra alanlar
                        source: "flashscore_scraper",
                        update_at: new Date().toISOString()
                    });
                }
            }
        });
        return results;
    }, dateStr);
}

// --- Tarih Navigasyonu (Zaman Makinesi) ---
async function navigateToDate(page, targetDate) {
    await page.emulateTimezone('Europe/Istanbul');
    console.log(`  📅 Hedef Tarih: ${formatDate(targetDate)}`);
    
    // Flashscore'a git
    await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Çerezleri kabul et
    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler');
        await sleep(2000);
    } catch(e) {}

    // "Dün" butonuna tıkla (Daily mod için)
    if (MODE === 'daily') {
        try {
            await page.click('.calendar__direction--yesterday');
            await sleep(5000); // Verilerin yüklenmesi için bekle
        } catch(e) {
            console.log("  ⚠️ Dün butonuna basılamadı, bugün verileri çekiliyor olabilir.");
        }
    } 
    // Not: Backfill modu için takvim açma mantığı eklenebilir ancak şu an Daily odaklı gidiyoruz.
}

// --- Firestore Kayıt ---
async function saveToFirestore(db, dateStr, matches) {
    const batch = db.batch();
    const dateRef = db.collection('matches').doc(dateStr);

    batch.set(dateRef, { lastUpdate: Timestamp.now(), count: matches.length }, { merge: true });

    matches.forEach(match => {
        const gameRef = dateRef.collection('games').doc(match.fixture.id);
        batch.set(gameRef, match, { merge: true });
    });

    await batch.commit();
    console.log(`  ✅ ${matches.length} maç API-FOOTBALL formatında Firestore'a yazıldı.`);
}

// --- ANA AKIŞ ---
(async () => {
    const db = initFirebase();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
    });
    const page = await browser.newPage();

    let targetDate = new Date();
    if (MODE === 'daily') targetDate.setDate(targetDate.getDate() - 1);
    if (MODE === 'single' && SINGLE) targetDate = new Date(SINGLE);

    try {
        await navigateToDate(page, targetDate);
        const matches = await collectMatches(page, targetDate);
        
        if (matches.length > 0) {
            await saveToFirestore(db, formatDate(targetDate), matches);
        } else {
            console.log("  ❌ Kaydedilecek maç bulunamadı.");
        }
    } catch (e) {
        console.error("  🔴 KRİTİK HATA:", e.message);
    } finally {
        await browser.close();
        process.exit();
    }
})();
