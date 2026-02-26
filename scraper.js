async function collectMatches(page, targetDate) {
    const dateStr = formatDate(targetDate);
    const timestamp = Math.floor(targetDate.getTime() / 1000);

    return await page.evaluate((dateStr, timestamp) => {
        const results = [];
        // Flashscore'daki TÜM maç satırlarını yakala
        const matchElements = document.querySelectorAll('.event__match');
        
        matchElements.forEach(el => {
            // Satır saymak yerine doğrudan HTML class'larına bakıyoruz
            const homeTeamEl = el.querySelector('.event__participant--home');
            const awayTeamEl = el.querySelector('.event__participant--away');
            const homeScoreEl = el.querySelector('.event__score--home');
            const awayScoreEl = el.querySelector('.event__score--away');

            // Eğer takım isimleri ve skorlar ekranda tam olarak varsa işlemi yap
            if (homeTeamEl && awayTeamEl && homeScoreEl && awayScoreEl) {
                const homeTeam = homeTeamEl.innerText.trim();
                const awayTeam = awayTeamEl.innerText.trim();
                const hScore = parseInt(homeScoreEl.innerText.trim());
                const aScore = parseInt(awayScoreEl.innerText.trim());

                // Skor alanında rakam yazıyorsa (yani maç oynanmışsa/oynanıyorsa) listeye ekle
                if (!isNaN(hScore) && !isNaN(aScore)) {
                    // Flashscore ID'sini al, yoksa benzersiz bir sayı üret
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
