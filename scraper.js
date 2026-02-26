const puppeteer = require('puppeteer');

(async () => {
    console.log("ScorePop Geçmiş Maçlar Botu başlatılıyor...");
    
    // Tarayıcıyı ekran boyutu belirterek açıyoruz ki mobil görünüme geçip butonları saklamasın
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'] 
    });
    
    const page = await browser.newPage();
    
    // Sitenin bizi bot olarak algılamasını engellemek için gerçek bir Chrome kimliği veriyoruz
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log("Flashscore ana sayfasına gidiliyor...");
    // GitHub sunucuları yavaş olabileceği için 60 saniye süre tanıyoruz
    await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'networkidle2', timeout: 60000 });

    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler');
        await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (e) {
        // Çerez yoksa devam et
    }

    console.log("Dünün maçlarına geçiliyor...");
    try {
        // "Dün" butonunun adı değişmiş olabilir, alternatifleri deniyoruz
        await page.waitForSelector('.calendar__direction--yesterday, [title="Önceki gün"], .calendar__navigation--yesterday', { timeout: 10000 });
        await page.click('.calendar__direction--yesterday, [title="Önceki gün"], .calendar__navigation--yesterday');
        
        // Tıkladıktan sonra verilerin gelmesi için 5 saniye bekle (Çok kritik!)
        await new Promise(resolve => setTimeout(resolve, 5000)); 
    } catch (e) {
        console.log("UYARI: Dünün butonuna tıklanamadı, ana sayfadaki mevcut veriler çekiliyor.");
    }

    console.log("Skorlar ekrandan toplanıyor...");
    const matches = await page.evaluate(() => {
        const results = [];
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            // Sınıf isimlerinin tamamı yerine sadece "içinde geçen" kelimeleri arıyoruz (Daha güvenli)
            const homeTeamEl = el.querySelector('[class*="participant--home"]');
            const awayTeamEl = el.querySelector('[class*="participant--away"]');
            const homeScoreEl = el.querySelector('[class*="score--home"]');
            const awayScoreEl = el.querySelector('[class*="score--away"]');
            
            const homeTeam = homeTeamEl ? homeTeamEl.innerText.trim() : '';
            const awayTeam = awayTeamEl ? awayTeamEl.innerText.trim() : '';
            const homeScore = homeScoreEl ? homeScoreEl.innerText.trim() : '';
            const awayScore = awayScoreEl ? awayScoreEl.innerText.trim() : '';
            
            // Eğer takım isimleri boş değilse listeye ekle
            if(homeTeam !== '' && awayTeam !== '') {
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
    
    if (matches.length > 0) {
        console.log(JSON.stringify(matches.slice(0, 15), null, 2)); // İlk 15 maçı göster
    } else {
        console.log("Hata: Takım isimleri okunamadı. Flashscore tasarımı değiştirmiş olabilir.");
    }
    
    await browser.close();
    console.log("Görev tamamlandı, bot uykuya geçiyor.");
})();
