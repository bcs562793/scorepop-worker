const puppeteer = require('puppeteer');

(async () => {
    console.log("ScorePop Geçmiş Maçlar Botu başlatılıyor...");
    
    // GitHub Actions sunucularında (Linux) sorunsuz çalışması için gerekli güvenlik argümanları
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    
    // Flashscore ana sayfasına gidiyoruz
    await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2' });

    // Çerez (Cookie) uyarısı çıkarsa kapatıyoruz ki butonları engellemesin
    try {
        await page.click('#onetrust-accept-btn-handler');
    } catch (e) {
        // Çerez çıkmazsa sorun yok, devam et.
    }

    // Dünün maçlarını görmek için "Dün" (Sol ok) butonuna tıklatıyoruz
    try {
        await page.waitForSelector('.calendar__direction--yesterday', { timeout: 5000 });
        await page.click('.calendar__direction--yesterday');
        // Maçların yüklenmesi için 3 saniye bekle
        await new Promise(resolve => setTimeout(resolve, 3000)); 
    } catch (e) {
        console.log("Dünün butonuna tıklanamadı, ana sayfadaki mevcut maçlar çekiliyor.");
    }

    console.log("Skorlar ekrandan toplanıyor...");
    const matches = await page.evaluate(() => {
        const results = [];
        // Maçların olduğu satırları seç
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            const homeTeam = el.querySelector('.event__participant--home')?.innerText.trim() || '';
            const awayTeam = el.querySelector('.event__participant--away')?.innerText.trim() || '';
            const homeScore = el.querySelector('.event__score--home')?.innerText.trim() || '';
            const awayScore = el.querySelector('.event__score--away')?.innerText.trim() || '';
            
            // Eğer skor boş değilse (maç oynanmış ve bitmişse) listeye ekle
            if(homeScore !== '') {
                results.push({ 
                    homeTeam, 
                    awayTeam, 
                    score: `${homeScore} - ${awayScore}` 
                });
            }
        });
        return results;
    });

    console.log(`Toplam ${matches.length} maç sonucu başarıyla çekildi.`);
    console.log(JSON.stringify(matches.slice(0, 5), null, 2)); // Örnek olarak terminale ilk 5 maçı yazdırır
    
    // BURAYA EKLEME YAPILACAK: 
    // İleride matches dizisini veritabanına (Firebase, Supabase vb.) kaydedecek kod buraya gelecek.

    await browser.close();
    console.log("Görev tamamlandı, bot uykuya geçiyor.");
})();
