const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    console.log("ScorePop Final Veri Toplayıcı Başlatılıyor...");
    
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'] 
    });
    
    const page = await browser.newPage();
    
    console.log("Flashscore'a sızılıyor...");
    await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler');
        await new Promise(r => setTimeout(r, 1000));
    } catch(e) {}

    console.log("Dünün maçları için zaman yolculuğu yapılıyor...");
    try {
        await page.evaluate(() => {
            const btn = document.querySelector('.calendar__direction--yesterday') || document.querySelector('.calendar__navigation--yesterday');
            if(btn) btn.click();
        });
        // Sayfanın kesinlikle yenilenmesi için bekleme süresini 8 saniyeye çıkardık
        await new Promise(r => setTimeout(r, 8000)); 
    } catch (e) {
        console.log("UYARI: Zaman yolculuğu butonu tetiklenemedi.");
    }

    console.log("Maçlar temiz JSON formatına dönüştürülüyor...");
    const matchesData = await page.evaluate(() => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            const rawText = el.innerText;
            const lines = rawText.split('\n').map(line => line.trim()).filter(line => line !== '');
            
            // Eğer yeterli satır varsa (Saat/Durum, Ev Sahibi, Deplasman, Skor1, Skor2)
            if (lines.length >= 5) {
                results.push({
                    match_status: lines[0], // Örn: "MS" veya "17:45"
                    home_team: lines[1],    // Örn: "Galatasaray"
                    away_team: lines[2],    // Örn: "Fenerbahçe"
                    score: {
                        home: lines[3],     // Örn: "2" veya "-"
                        away: lines[4]      // Örn: "1" veya "-"
                    }
                });
            }
        });
        return results;
    });

    console.log(`Toplam ${matchesData.length} maç ScorePop formatına çevrildi!`);
    
    if (matchesData.length > 0) {
        // LİMİTİ KALDIRDIK: Artık 72 maçın TAMAMINI ekrana basacak!
        console.log(JSON.stringify(matchesData, null, 2));
    } else {
        console.log("Hata: Dönüştürülecek maç bulunamadı.");
    }
    
    await browser.close();
    console.log("Operasyon başarıyla tamamlandı.");
})();
