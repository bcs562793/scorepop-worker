const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin()); // Görünmezlik pelerinini giyiyoruz

(async () => {
    console.log("ScorePop Hayalet Bot Başlatılıyor...");
    
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'] 
    });
    
    const page = await browser.newPage();
    
    console.log("Flashscore'a sızılıyor...");
    await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });

    // DİAGNOSTİK: Sayfanın başlığını okuyup bot korumasına takılıp takılmadığımızı anlıyoruz
    const pageTitle = await page.title();
    console.log("📌 Girdiğimiz Sayfanın Başlığı:", pageTitle);

    if (pageTitle.includes("Just a moment") || pageTitle.includes("Cloudflare")) {
        console.log("🚨 DİKKAT: Cloudflare duvarına çarptık! Sistem bizi hala bot sanıyor.");
    }

    // Çerezleri kapat
    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler');
        await new Promise(r => setTimeout(r, 1000));
    } catch(e) {}

    console.log("Dünün maçları için zaman yolculuğu yapılıyor...");
    try {
        // Tıklamayı daha agresif bir yolla (doğrudan JS kodu çalıştırarak) yapıyoruz
        await page.evaluate(() => {
            const btn = document.querySelector('.calendar__direction--yesterday') || document.querySelector('.calendar__navigation--yesterday');
            if(btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 6000)); // Verilerin sunucudan inmesini bekle
    } catch (e) {
        console.log("UYARI: Zaman yolculuğu butonu tetiklenemedi.");
    }

    console.log("Hedef veriler toplanıyor...");
    const matches = await page.evaluate(() => {
        const results = [];
        // Flashscore'un en zayıf noktası: Her maçı ID'si 'g_1_' ile başlayan bir blokta tutmak zorundalar.
        const matchElements = document.querySelectorAll('div[id^="g_1_"]');
        
        matchElements.forEach(el => {
            const homeTeam = el.querySelector('.event__participant--home')?.innerText.trim() || '';
            const awayTeam = el.querySelector('.event__participant--away')?.innerText.trim() || '';
            const homeScore = el.querySelector('.event__score--home')?.innerText.trim() || '';
            const awayScore = el.querySelector('.event__score--away')?.innerText.trim() || '';
            
            if(homeTeam && awayTeam) {
                results.push({ 
                    homeTeam, 
                    awayTeam, 
                    score: `${homeScore} - ${awayScore}` 
                });
            }
        });
        return results;
    });

    console.log(`Toplam ${matches.length} maç sonucu kopyalandı.`);
    
    if (matches.length > 0) {
        console.log(JSON.stringify(matches.slice(0, 15), null, 2));
    } else {
        console.log("Hata: Maç bulunamadı. Sitenin gövde (body) yapısı beklenenden farklı yüklendi.");
    }
    
    await browser.close();
    console.log("Operasyon tamamlandı, izler siliniyor...");
})();
