const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    console.log("ScorePop Türkiye Saat Dilimi Botu Başlatılıyor...");
    
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'] 
    });
    
    const page = await browser.newPage();
    
    // KRİTİK DÜZELTME 1: Tarayıcıyı Türkiye saat dilimine zorluyoruz! (Gün kaymalarını önler)
    await page.emulateTimezone('Europe/Istanbul');
    
    console.log("Flashscore'a sızılıyor...");
    await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler');
        await new Promise(r => setTimeout(r, 1000));
    } catch(e) {}

    console.log("25.02.2026 (Dün) tarihi için takvime tıklanıyor...");
    
    try {
        await page.waitForSelector('.calendar__direction--yesterday', { visible: true, timeout: 10000 });
        
        // KRİTİK DÜZELTME 2: Tıkladıktan sonra yeni günün verisinin ağdan inmesini bekliyoruz
        const [response] = await Promise.all([
            // Flashscore yeni gün için 'feed' kelimesi geçen bir istek atar, bunu yakalıyoruz
            page.waitForResponse(res => res.url().includes('feed') && res.status() === 200, { timeout: 15000 }),
            page.click('.calendar__direction--yesterday')
        ]);
        
        console.log("Takvim başarıyla değişti, 25 Şubat verileri indirildi!");
        await new Promise(r => setTimeout(r, 3000)); // Verilerin ekrana çizilmesi (render) için ufak bir pay
    } catch (e) {
        console.log("UYARI: Takvim butonuna tıklanamadı veya ağ yanıtı alınamadı!", e.message);
    }

    console.log("25 Şubat BİTMİŞ maçları süzülüyor...");
    const matchesData = await page.evaluate(() => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            const rawText = el.innerText;
            const lines = rawText.split('\n').map(line => line.trim()).filter(line => line !== '');
            
            if (lines.length >= 5) {
                const matchStatus = lines[0];
                const homeScore = lines[3];
                const awayScore = lines[4];

                // FİLTRE: Sadece BİTMİŞ (MS, Bitti, Pen vb.) maçları al. 
                // Skoru '-' olanları veya durumu saat (17:45) olanları çöpe at!
                if (homeScore !== "-" && awayScore !== "-" && isNaN(parseInt(matchStatus.charAt(0)))) {
                    results.push({
                        match_status: matchStatus,
                        home_team: lines[1],
                        away_team: lines[2],
                        score: {
                            home: homeScore,
                            away: awayScore
                        }
                    });
                }
            }
        });
        return results;
    });

    console.log(`Toplam ${matchesData.length} adet 25 Şubat maçı ScorePop formatına çevrildi!`);
    
    if (matchesData.length > 0) {
        console.log(JSON.stringify(matchesData, null, 2));
    } else {
        console.log("Hata: Dönüştürülecek 25 Şubat maçı bulunamadı.");
    }
    
    await browser.close();
    console.log("Operasyon başarıyla tamamlandı.");
})();
