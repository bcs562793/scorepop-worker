const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    console.log("ScorePop Zaman Yolcusu Başlatılıyor...");
    
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
        // Çerez menüsünün ekrandan tamamen kaybolmasını bekliyoruz ki takvimin üstünü kapatmasın
        await new Promise(r => setTimeout(r, 2000));
    } catch(e) {}

    console.log("Dünün maçları için React uyumlu tıklama yapılıyor...");
    try {
        await page.evaluate(() => {
            const btn = document.querySelector('.calendar__direction--yesterday') || document.querySelector('.calendar__navigation--yesterday');
            if(btn) {
                // Modern framework'leri (React/Vue) kandıran gerçekçi fare tıklaması
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            }
        });
        console.log("Tıklama başarılı, eski maçların ağdan inmesi bekleniyor...");
        await new Promise(r => setTimeout(r, 8000)); // Sayfanın tamamen yenilenmesi için bekle
    } catch (e) {
        console.log("UYARI: Zaman yolculuğu butonu bulunamadı.");
    }

    console.log("Veriler süzülüyor (Sadece BİTMİŞ maçlar alınacak)...");
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

                // FİLTRE: Eğer skor "-" ise veya durum saat ise (örn: 17:45), o maçı çöpe at!
                // Sadece MS, Bitti, Pen, Uz. gibi metinler veya oynanmış maçlar geçebilir.
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

    console.log(`Toplam ${matchesData.length} BİTMİŞ maç ScorePop formatına çevrildi!`);
    
    if (matchesData.length > 0) {
        console.log(JSON.stringify(matchesData, null, 2));
    } else {
        console.log("Hata: Dönüştürülecek bitmiş maç bulunamadı. Lütfen bekleyin veya scripti tekrar çalıştırın.");
    }
    
    await browser.close();
    console.log("Operasyon başarıyla tamamlandı.");
})();
