const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    console.log("ScorePop Ham Metin Okuyucu Başlatılıyor...");
    
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
        await new Promise(r => setTimeout(r, 5000)); // Verilerin inmesi için bekle
    } catch (e) {
        console.log("UYARI: Zaman yolculuğu butonu tetiklenemedi.");
    }

    console.log("Sınıf isimleri yok sayılıyor, ham metin (innerText) çekiliyor...");
    const matchesData = await page.evaluate(() => {
        const results = [];
        // İlk başta 72 maç bulan o ana çerçeveyi (event__match) kullanıyoruz
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            // Elementin içindeki TÜM metni al ve satırlara böl
            const rawText = el.innerText;
            // Boşlukları temizle ve boş olmayan satırları bir dizi (array) yap
            const lines = rawText.split('\n').map(line => line.trim()).filter(line => line !== '');
            
            // Eğer içinde veri varsa (en azından takım isimleri ve skorlar)
            if (lines.length >= 4) {
                results.push({
                    rawLines: lines // Şimdilik sadece bu satırları görelim
                });
            }
        });
        return results;
    });

    console.log(`Toplam ${matchesData.length} maç kutusu bulundu.`);
    
    if (matchesData.length > 0) {
        // Yapıyı çözebilmemiz için ilk 3 maçın ham halini ekrana basıyoruz
        console.log("İLK 3 MAÇIN HAM VERİ YAPISI:");
        console.log(JSON.stringify(matchesData.slice(0, 3), null, 2));
    } else {
        console.log("Hata: Maç kutuları (event__match) bulunamadı.");
    }
    
    await browser.close();
    console.log("Operasyon tamamlandı.");
})();
