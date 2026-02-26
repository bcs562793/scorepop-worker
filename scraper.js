const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

puppeteer.use(StealthPlugin());

const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE      = args.mode || 'daily';
const SINGLE    = args.date || null;
const FROM_DATE = args.from || null;
const TO_DATE   = args.to   || null;

function initFirebase() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT)
        throw new Error('FIREBASE_SERVICE_ACCOUNT bulunamadı!');
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    return getFirestore();
}

const formatDate = (d) => d.toISOString().split('T')[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── TARİH HESAPLAMA ─────────────────────────────────────────────────────────
function getTRToday() {
    // GitHub Actions UTC çalışır → TR saatine çevir
    const trStr = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Istanbul' });
    return new Date(trStr.split(',')[0] + 'T00:00:00Z');
}
function getYesterday() {
    const d = getTRToday();
    d.setUTCDate(d.getUTCDate() - 1);
    return d;
}
function parseTargetDate(s) {
    return new Date(s + 'T00:00:00Z');
}

// ─── SAYFADA HANGİ TARİHİN GÖRÜNDÜĞÜNÜ OKU ──────────────────────────────────
// Flashscore takvim alanında aktif tarihi gösterir.
// Bunu okuyup hedef tarihle karşılaştırıyoruz → navigasyon hatasını önler.
async function getPageCurrentDate(page) {
    return await page.evaluate(() => {
        // Takvim alanındaki tarih göstergesi
        const selectors = [
            '.calendar__static',
            '[class*="calendar__static"]',
            '[class*="calendar"] [class*="date"]',
            '[class*="calendar"] input',
            '[class*="calendarDate"]',
        ];
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (el && el.innerText && el.innerText.trim().length > 3) {
                return el.innerText.trim();
            }
            if (el && el.value) return el.value.trim();
        }

        // Alternatif: URL'den al
        const hash = window.location.hash || '';
        const m = hash.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];

        return null;
    });
}

// ─── TAKVİM OKU TIKLAMA ──────────────────────────────────────────────────────
async function clickCalendarArrow(page, direction) {
    const leftSel  = ['.calendar__direction--yesterday', '.calendar__navigation--yesterday',
                      '[class*="calendar"][class*="yesterday"]', '[class*="calLeft"]'];
    const rightSel = ['.calendar__direction--tomorrow', '.calendar__navigation--tomorrow',
                      '[class*="calendar"][class*="tomorrow"]', '[class*="calRight"]'];
    const sels = direction === 'left' ? leftSel : rightSel;

    for (const s of sels) {
        try {
            await page.waitForSelector(s, { visible: true, timeout: 2000 });
            await page.click(s); return true;
        } catch (_) {}
    }

    return await page.evaluate((dir) => {
        const kw = dir === 'left' ? ['yesterday','prev','left','back'] : ['tomorrow','next','right','forward'];
        const el = [...document.querySelectorAll('[class*="calendar"] button, [class*="calendar"] span, [class*="calendar"] a')]
            .find(e => kw.some(k => (e.className||'').toLowerCase().includes(k)));
        if (el) { el.click(); return true; }
        const svgs = [...document.querySelectorAll('[class*="calendar"] svg')];
        const idx  = dir === 'left' ? 0 : svgs.length - 1;
        if (svgs[idx]) { const p = svgs[idx].closest('button,a,span,div'); if (p) { p.click(); return true; } }
        return false;
    }, direction);
}

// ─── SAYFADA DOĞRU TARİHE GİT ────────────────────────────────────────────────
async function navigateToDate(page, targetDate) {
    const targetStr = formatDate(targetDate);

    // ── Adım 1: Sayfada şu an hangi tarih gösteriliyor? ──────────────────────
    const pageDate = await getPageCurrentDate(page);
    console.log(`  📅 Hedef: ${targetStr} | Sayfada şu an: ${pageDate || 'okunamadı'}`);

    // ── Adım 2: Sayfadaki tarihi parse et ────────────────────────────────────
    // Flashscore genellikle "DD.MM.YYYY" veya "YYYY-MM-DD" formatında gösterir
    let currentDate = null;
    if (pageDate) {
        // "27.02.2026" → 2026-02-27
        const dotMatch = pageDate.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dotMatch) {
            currentDate = new Date(`${dotMatch[3]}-${dotMatch[2].padStart(2,'0')}-${dotMatch[1].padStart(2,'0')}T00:00:00Z`);
        }
        // "2026-02-27" direkt
        const isoMatch = pageDate.match(/(\d{4}-\d{2}-\d{2})/);
        if (!currentDate && isoMatch) {
            currentDate = new Date(isoMatch[1] + 'T00:00:00Z');
        }
    }

    // ── Adım 3: Sayfa tarihi okunamazsa TR bugününü varsay ───────────────────
    if (!currentDate) {
        currentDate = getTRToday();
        console.log(`  ⚠️  Sayfa tarihi okunamadı, TR bugünü varsayıldı: ${formatDate(currentDate)}`);
    }

    // ── Adım 4: Kaç adım gidileceğini hesapla ────────────────────────────────
    const diff = Math.round((currentDate - targetDate) / 86400000);
    console.log(`  🔢 ${formatDate(currentDate)} → ${targetStr} = ${diff > 0 ? diff + ' adım geri' : diff < 0 ? Math.abs(diff) + ' adım ileri' : 'zaten doğru tarih'}`);

    if (diff === 0) {
        console.log('  ✅ Zaten doğru tarihte.');
        return;
    }

    const dir   = diff > 0 ? 'left' : 'right';
    const steps = Math.abs(diff);

    for (let i = 0; i < steps; i++) {
        if (i === 0) {
            try {
                await Promise.race([
                    Promise.all([
                        page.waitForResponse(r => r.status() === 200 &&
                            (r.url().includes('feed') || r.url().includes('flashscore') || r.url().includes('event')),
                            { timeout: 10000 }),
                        clickCalendarArrow(page, dir)
                    ]),
                    sleep(6000).then(() => clickCalendarArrow(page, dir))
                ]);
            } catch (_) { await clickCalendarArrow(page, dir); }
            await sleep(3000);
        } else {
            await clickCalendarArrow(page, dir);
            await sleep(800);
            if ((i + 1) % 10 === 0) { console.log(`     ${i+1}/${steps}...`); await sleep(1500); }
        }
    }

    await sleep(3000);
    const finalDate = await getPageCurrentDate(page);
    console.log(`  ✅ Navigasyon tamamlandı. Sayfada şu an: ${finalDate || '?'}`);
}

// ─── DOM YAPISI KEŞFET ───────────────────────────────────────────────────────
// event__header bulunamadığında geniş bir tarama yapar ve gerçek class'ı bulur
async function discoverDOMStructure(page) {
    return await page.evaluate(() => {
        const info = {};

        // 1. Spor konteynerini bul
        const sportContainers = [
            '.sportName.soccer', '.sportName', '#live-table',
            '[class*="soccer"]', '[class*="sportName"]', '.leagues--live',
        ];
        for (const s of sportContainers) {
            const el = document.querySelector(s);
            if (el) { info.sportContainer = s; break; }
        }

        // 2. .event__header var mı? Yoksa benzer ne var?
        info.eventHeaderCount = document.querySelectorAll('.event__header').length;

        // event__ prefix'li tüm unique class'ları bul
        const allClasses = new Set();
        document.querySelectorAll('[class*="event__"]').forEach(el => {
            el.className.split(/\s+/).filter(c => c.includes('event__')).forEach(c => allClasses.add(c));
        });
        info.eventClasses = [...allClasses].sort();

        // 3. Lig başlığı olabilecek elementleri bul
        const headerCandidates = [];
        ['[class*="header"]', '[class*="league"]', '[class*="section"]', '[class*="title"]'].forEach(s => {
            document.querySelectorAll(s).forEach(el => {
                const txt = el.innerText?.trim();
                if (txt && txt.length > 3 && txt.length < 100 && !el.querySelector('[class*="event__match"]')) {
                    headerCandidates.push({ class: el.className, text: txt.slice(0, 80) });
                }
            });
        });
        info.headerCandidates = [...new Map(headerCandidates.map(h => [h.class, h])).values()].slice(0, 15);

        // 4. İlk .event__match'in parent zinciri — lig bilgisi nerede?
        const firstMatch = document.querySelector('.event__match');
        if (firstMatch) {
            const chain = [];
            let el = firstMatch.parentElement;
            for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
                chain.push({
                    tag: el.tagName,
                    class: el.className?.slice(0, 80),
                    // Bu parent'ın sibling'larında header benzeri bir şey var mı?
                    prevSiblings: [...(el.parentElement?.children || [])].filter(c => c !== el)
                        .slice(0, 3).map(c => ({ class: c.className?.slice(0,60), text: c.innerText?.trim().slice(0,60) }))
                });
            }
            info.matchParentChain = chain;

            // İlk match'ten önceki sibling'lar
            const prev = [];
            let sib = firstMatch.previousElementSibling;
            for (let i = 0; i < 5 && sib; i++, sib = sib.previousElementSibling) {
                prev.push({ class: sib.className?.slice(0,80), text: sib.innerText?.trim().slice(0,80) });
            }
            info.matchPrevSiblings = prev;
        }

        return info;
    });
}

// ─── LİG BAŞLIĞINI ÇÖZEN FONKSİYON ──────────────────────────────────────────
// discoverDOMStructure çıktısına göre doğru selector'ı seç
function buildHeaderSelector(domInfo) {
    // Önce event__ class listesine bak
    const ec = domInfo.eventClasses || [];
    const headerClass = ec.find(c => c.includes('header') || c.includes('title') || c.includes('league'));
    if (headerClass) return '.' + headerClass;

    // Fallback
    return '[class*="event__header"], [class*="event__title"], [class*="leagueName"]';
}

// ─── MAÇLARI TOPLA ───────────────────────────────────────────────────────────
async function collectMatches(page, targetDate) {
    const dateStr    = formatDate(targetDate);
    const timestamp  = Math.floor(targetDate.getTime() / 1000);
    const seasonYear = targetDate.getFullYear();

    // DOM yapısını keşfet
    const domInfo = await discoverDOMStructure(page);
    console.log('\n  🔬 DOM Keşif Raporu:');
    console.log(`     Sport container : ${domInfo.sportContainer || 'bulunamadı'}`);
    console.log(`     .event__header  : ${domInfo.eventHeaderCount} adet`);
    console.log(`     event__ classes : ${(domInfo.eventClasses || []).join(', ')}`);
    if (domInfo.matchPrevSiblings?.length) {
        console.log('     Match öncesi sibling\'lar:');
        domInfo.matchPrevSiblings.forEach(s => console.log(`       class="${s.class}" → "${s.text}"`));
    }
    if (domInfo.headerCandidates?.length) {
        console.log('     Başlık adayları:');
        domInfo.headerCandidates.slice(0, 5).forEach(h => console.log(`       class="${h.class}" → "${h.text}"`));
    }
    console.log('');

    // Scroll
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let pos = 0;
            const t = setInterval(() => {
                window.scrollBy(0, 400); pos += 400;
                if (pos >= document.body.scrollHeight) { clearInterval(t); resolve(); }
            }, 150);
        });
    });
    await sleep(1500);

    // Gerçek event__ class adlarını geç
    const eventClasses = domInfo.eventClasses || [];

    return await page.evaluate((dateStr, timestamp, seasonYear, eventClasses) => {

        // ── Lig başlığını parse et (her tür yapıya karşı dayanıklı) ──────────
        function parseLeagueText(text) {
            const t = text.trim().replace(/\s+/g, ' ');
            const ci = t.indexOf(':');
            if (ci > -1) return { country: t.slice(0, ci).trim(), name: t.slice(ci + 1).trim() };
            const di = t.indexOf(' - ');
            if (di > -1) return { country: t.slice(0, di).trim(), name: t.slice(di + 3).trim() };
            return { country: 'Unknown', name: t };
        }

        function leagueHash(n) {
            let h = 0;
            for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h);
            return Math.abs(h);
        }

        // ── Doğru header selector'ı bul ──────────────────────────────────────
        // eventClasses içinde "header" geçen class'ı ara
        let headerSel = '.event__header'; // varsayılan
        const headerClass = eventClasses.find(c => c.toLowerCase().includes('header'));
        if (headerClass) headerSel = '.' + headerClass;

        // ── Tüm satırları sıraya göre al ─────────────────────────────────────
        // Header ve match'ler aynı parent altında sıralı olmalı
        // Birden fazla selector'ı birleştirerek tüm satırları çekiyoruz
        const allRows = document.querySelectorAll(`${headerSel}, .event__match`);

        const results = [];
        let league = { id: 0, name: 'Unknown League', country: 'Unknown' };

        allRows.forEach(el => {
            const cls = (el.className || '').toLowerCase();

            // ── Header mi? ───────────────────────────────────────────────────
            const isHeader = cls.includes('header') && !cls.includes('match');
            if (isHeader) {
                // Yöntem 1: Ayrı ülke + lig span'ları
                const spans = [...el.querySelectorAll('span, a, strong, div')]
                    .map(c => c.innerText?.trim()).filter(Boolean);

                let parsed;
                if (spans.length >= 2) {
                    // İlk span ülke, geri kalan lig
                    const raw = spans.join(': ');
                    parsed = parseLeagueText(raw);
                } else {
                    parsed = parseLeagueText(el.innerText || '');
                }

                league = { id: leagueHash(parsed.name), name: parsed.name, country: parsed.country };
                return;
            }

            // ── Match mi? ────────────────────────────────────────────────────
            const isMatch = cls.includes('match');
            if (!isMatch) return;

            const lines = el.innerText.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 5) return;

            const status  = lines[0];
            let home      = lines[1];
            let away      = lines[2];
            let homeScore = lines[3];
            let awayScore = lines[4];

            // Kırmızı kart kayması
            if (!isNaN(parseInt(away))) { away = lines[3]; homeScore = lines[4]; awayScore = lines[5]; }

            const finished = (
                homeScore !== '-' && awayScore !== '-' &&
                !isNaN(parseInt(homeScore)) && !isNaN(parseInt(awayScore)) &&
                isNaN(parseInt(status.charAt(0)))
            );
            if (!finished) return;

            const h  = parseInt(homeScore) || 0;
            const a  = parseInt(awayScore) || 0;
            const id = el.id
                ? (parseInt(el.id.replace('g_1_',''), 36) || el.id.replace('g_1_','').split('').reduce((s,c) => s + c.charCodeAt(0), 0))
                : Math.floor(Math.random() * 1e6);

            results.push({
                fixture: {
                    id, referee: null, timezone: 'Europe/Istanbul',
                    date: `${dateStr}T20:00:00+03:00`, timestamp,
                    periods: { first: null, second: null },
                    venue: { id: null, name: null, city: null },
                    status: { long: 'Match Finished', short: 'FT', elapsed: 90, extra: null }
                },
                league: {
                    id: league.id, name: league.name, country: league.country,
                    logo: null, flag: null, season: seasonYear,
                    round: 'Regular Season', standings: false
                },
                teams: {
                    home: { id: 0, name: home, logo: null, winner: h > a ? true : (h === a ? null : false) },
                    away: { id: 0, name: away, logo: null, winner: a > h ? true : (h === a ? null : false) }
                },
                goals: { home: h, away: a },
                score: {
                    halftime:  { home: null, away: null },
                    fulltime:  { home: h, away: a },
                    extratime: { home: null, away: null },
                    penalty:   { home: null, away: null }
                }
            });
        });

        return results;
    }, dateStr, timestamp, seasonYear, eventClasses);
}

// ─── FİRESTORE'A YAZ ─────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    await db.collection('archive_matches').doc(dateStr).set({
        fixtures:      matches,
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
    }, { merge: true });

    console.log(`  ✅ ${matches.length} maç → archive_matches/${dateStr} ✔`);
    const leagues = [...new Set(matches.map(m => `${m.league.country}: ${m.league.name}`))];
    console.log(`  📋 ${leagues.length} lig: ${leagues.slice(0, 6).join(' | ')}${leagues.length > 6 ? ` ... (+${leagues.length-6})` : ''}`);
}

// ─── TEK GÜN İŞLE ────────────────────────────────────────────────────────────
async function processDate(page, db, targetDate) {
    const dateStr = formatDate(targetDate);
    console.log(`\n📆 İşleniyor: ${dateStr}`);

    await navigateToDate(page, targetDate);

    console.log('⚽ Bitmiş maçlar toplanıyor...');
    const matches = await collectMatches(page, targetDate);
    console.log(`🏆 ${matches.length} bitmiş maç bulundu.`);

    if (matches.length > 0) {
        await saveToFirestore(db, dateStr, matches);
    } else {
        const count = await page.evaluate(() => document.querySelectorAll('.event__match').length);
        console.log(`  ❌ Bitmiş maç yok. (Sayfada ${count} .event__match var)`);
    }
}

// ─── ANA AKIŞ ─────────────────────────────────────────────────────────────────
(async () => {
    const db = initFirebase();
    console.log('🤖 ScorePop Botu Başlatılıyor...');
    console.log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
               '--disable-gpu','--window-size=1920,1080','--disable-blink-features=AutomationControlled'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.emulateTimezone('Europe/Istanbul');
    await page.setRequestInterception(true);
    page.on('request', r => ['image','font','media'].includes(r.resourceType()) ? r.abort() : r.continue());

    console.log("🔍 Flashscore'a bağlanılıyor...");
    try {
        await page.goto('https://www.flashscore.com.tr/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (_) { console.log('⚠️ Yükleme timeout, devam...'); }

    if ((await page.title()).toLowerCase().includes('just a moment')) {
        console.log('🛡️ Cloudflare engeli, 20s bekleniyor...'); await sleep(20000);
    }
    try {
        await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
        await page.click('#onetrust-accept-btn-handler'); await sleep(1000);
        console.log('🍪 Çerez kabul edildi.');
    } catch (_) {}
    await sleep(2000);

    try {
        if (MODE === 'daily') {
            const yesterday = getYesterday();
            console.log(`📅 TR saatine göre dün: ${formatDate(yesterday)}`);
            await processDate(page, db, yesterday);

        } else if (MODE === 'single') {
            if (!SINGLE) throw new Error('--date gerekli! Örn: --date=2026-02-26');
            await processDate(page, db, parseTargetDate(SINGLE));

        } else if (MODE === 'backfill') {
            if (!FROM_DATE || !TO_DATE) throw new Error('--from ve --to gerekli!');
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end - start) / 86400000) + 1;
            console.log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);
            for (let i = 0; i < total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate() + i);
                await processDate(page, db, d);
                if (i < total - 1) await sleep(3000 + Math.random() * 2000);
            }
        }
    } catch (e) {
        console.error('🔴 KRİTİK HATA:', e.message);
        await browser.close(); process.exit(1);
    }

    await browser.close();
    console.log('\n🏁 Operasyon tamamlandı.');
    process.exit(0);
})();
