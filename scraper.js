/**
 * ScorePop — Mackolik → Firebase Scraper
 * Flashscore bot ile aynı Firebase yapısını kullanır.
 *
 * Kullanım:
 *   node mackolik_firebase.js --mode=daily
 *   node mackolik_firebase.js --mode=single --date=2026-02-24
 *   node mackolik_firebase.js --mode=backfill --from=2026-02-01 --to=2026-02-28
 */

const https = require('https');
const fs    = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

// ─── LOG ─────────────────────────────────────────────────────────────────────
const logFile = fs.createWriteStream('scraper.log', { flags: 'w' });
function log(...a)    { const m = a.join(' '); console.log(m);   logFile.write(m + '\n'); }
function logErr(...a) { const m = a.join(' '); console.error(m); logFile.write('[ERR] ' + m + '\n'); }

process.on('uncaughtException',  e => { logErr('💥 UNCAUGHT:',   e.stack || e.message); logFile.end(() => process.exit(1)); });
process.on('unhandledRejection', e => { logErr('💥 REJECTION:', e?.stack || e);          logFile.end(() => process.exit(1)); });

// ─── ARGS ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
const MODE      = args.mode || 'daily';
const SINGLE    = args.date || null;
const FROM_DATE = args.from || null;
const TO_DATE   = args.to   || null;

log('🤖 ScorePop Mackolik Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);
log(`🔧 Node: ${process.version}`);

// ─── FİREBASE ────────────────────────────────────────────────────────────────
function initFirebase() {
    log('🔥 Firebase başlatılıyor...');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT bulunamadı!');
    const sa = JSON.parse(raw);
    log(`   ✓ Proje: ${sa.project_id}`);
    initializeApp({ credential: cert(sa) });
    const db = getFirestore();
    log('   ✓ Firestore hazır.');
    return db;
}

// ─── YARDIMCILAR ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getTRToday() {
    const s = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Istanbul' });
    return new Date(s.split(',')[0] + 'T00:00:00Z');
}
function getYesterday() { const d = getTRToday(); d.setUTCDate(d.getUTCDate() - 1); return d; }

function parseTargetDate(s) {
    if (!s || typeof s !== 'string') throw new Error(`Geçersiz tarih: ${s}`);
    const clean = s.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new Error(`Tarih YYYY-MM-DD formatında olmalı: "${clean}"`);
    const d = new Date(clean + 'T00:00:00Z');
    if (isNaN(d.getTime())) throw new Error(`Geçersiz tarih: "${clean}"`);
    return d;
}

/** JS Date → 'YYYY-MM-DD' */
const formatDate = d => d.toISOString().split('T')[0];

/** JS Date → mackolik API formatı 'DD/MM/YYYY' */
const toMacDate = d => {
    const [y, m, day] = formatDate(d).split('-');
    return `${day}/${m}/${y}`;
};

// ─── MACKOLİK API ─────────────────────────────────────────────────────────────
function fetchMackolik(dateStr) {
    return new Promise((resolve, reject) => {
        // dateStr: 'DD/MM/YYYY' → encodeURIComponent gerekli
        const url = `https://vd.mackolik.com/livedata?date=${encodeURIComponent(dateStr)}`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept':     'application/json',
                'Referer':    'https://arsiv.mackolik.com/',
            }
        };
        https.get(url, options, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch(e) { reject(new Error(`JSON parse hatası: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

// ─── SPOR TİPİ ────────────────────────────────────────────────────────────────
// m[36][11]: 1=futbol, 2=basketbol
const SPORT_TYPE = { 1: 'Football', 2: 'Basketball', 3: 'Other' };

// Durum kodu → flashscore uyumlu status objesi
function parseStatus(statusCode, statusText) {
    const map = {
        0:  { long: 'Not Started',     short: 'NS',  elapsed: null },
        4:  { long: 'Match Finished',  short: 'FT',  elapsed: 90   },
        8:  { long: 'Match Finished',  short: 'PEN', elapsed: 120  },
        9:  { long: 'Postponed',       short: 'PST', elapsed: null },
        20: { long: 'Extra Time',      short: 'ET',  elapsed: 105  },
        13: { long: 'Match Finished',  short: 'FT',  elapsed: null },  // Basketbol
    };
    return { ...(map[statusCode] || { long: statusText || 'Unknown', short: 'UN', elapsed: null }), extra: null };
}

// ─── TEK MAÇ PARSE ────────────────────────────────────────────────────────────
/*
  Mackolik m dizisi:
  [0]  matchId
  [1]  homeId
  [2]  homeName
  [3]  awayId
  [4]  awayName
  [5]  statusCode
  [6]  statusText (MS / Ert. / vb.)
  [7]  scoreStr ("2-1")
  [10] redCard home (int)
  [11] redCard away (int)
  [12] home shots on target (int)
  [13] away shots on target (int)
  [16] time string ("20:45")
  [17] isNeutral? (1=nötr)
  [18] odd1
  [19] oddX
  [20] odd2
  [29] IY home string
  [30] IY away string
  [31] final home goals (string)
  [32] final away goals (string)
  [35] date string ("24/02/2026")
  [36] [countryId, countryName, leagueId, leagueName, tournId, season, "", aeleme, ?, leagueCode, ?, sportType]
  [37] hasOdds
*/
// ─── TEK MAÇ PARSE ────────────────────────────────────────────────────────────
// Durum kodu → flashscore uyumlu status objesi
// ─── TEK MAÇ PARSE (KUSURSUZ SKOR VE İLK YARI YAMASI) ─────────────────────────
// ─── TEK MAÇ PARSE (LOGOLAR DİNAMİK OLARAK EKLENDİ) ──────────────────────────
function parseMatch(m, targetDate) {
    if (!Array.isArray(m) || m.length < 37) return null;

    const li = Array.isArray(m[36]) ? m[36] : [];

    // 🔥 BASKETBOLU TAMAMEN ÇÖPE AT (Sadece 1 = Futbol) 🔥
    const sportTypeId = parseInt(li[11], 10) || 1;
    if (sportTypeId !== 1) return null;

    // 🔥 FLUTTER İÇİN ZORUNLU INTEGER DÖNÜŞÜMLERİ 🔥
    const matchId    = parseInt(m[0], 10) || 0;
    const homeId     = parseInt(m[1], 10) || 0;
    const awayId     = parseInt(m[3], 10) || 0;
    const countryId  = parseInt(li[0], 10) || 0; // LİG/ÜLKE LOGOSU İÇİN
    const leagueId   = parseInt(li[2], 10) || 0;
    const seasonYear = parseInt(targetDate.getFullYear(), 10);

    const toInt = v => { 
        if (v === null || v === undefined || v === '') return null;
        const n = parseInt(v, 10); 
        return isNaN(n) ? null : n; 
    };

    // 🔥 GERÇEK MAÇ SONUCU (FT) SKORLARI 🔥
    let homeGoals = toInt(m[12]);
    let awayGoals = toInt(m[13]);
    
    // 🔥 "MS" YAZISINDAN SONRA GELEN İLK YARI (HT) SKORUNU PARÇALAMA 🔥
    let htHome = null;
    let htAway = null;
    const htStr = typeof m[7] === 'string' ? m[7].replace(/\s/g, '') : '';
    if (htStr.includes('-')) {
        const parts = htStr.split('-');
        htHome = toInt(parts[0]);
        htAway = toInt(parts[1]);
    }

    // Kırmızı Kartlar (8 ve 9. indeksler)
    const rcHome = toInt(m[8]) || 0;
    const rcAway = toInt(m[9]) || 0;

    // Durum
    const statusCode = parseInt(m[5], 10) || 0;
    const statusText = typeof m[6] === 'string'  ? m[6] : '';
    const status     = parseStatus(statusCode, statusText);

    // Lig bilgisi
    const countryName = li[1]  ?? 'Unknown';
    const leagueName  = li[3]  ?? 'Unknown';

    // Tarih+saat
    const dateStr   = formatDate(targetDate);
    const timeStr   = typeof m[16] === 'string' ? m[16] : '00:00';
    const isoDate   = `${dateStr}T${timeStr}:00+03:00`;
    const timestamp = parseInt(Math.floor(targetDate.getTime() / 1000), 10);

    // Kazananlar
    const homeWin = homeGoals !== null && awayGoals !== null
        ? (homeGoals > awayGoals ? true : homeGoals === awayGoals ? null : false)
        : null;
    const awayWin = homeGoals !== null && awayGoals !== null
        ? (awayGoals > homeGoals ? true : homeGoals === awayGoals ? null : false)
        : null;

    // 🔥 HARİKA HİLE: LOGOLARI HTML'YE GİRMEDEN ID'LERDEN ÜRETİYORUZ 🔥
    const homeLogoUrl   = homeId > 0 ? `https://im.mackolik.com/img/logo/buyuk/${homeId}.gif` : null;
    const awayLogoUrl   = awayId > 0 ? `https://im.mackolik.com/img/logo/buyuk/${awayId}.gif` : null;
    const leagueLogoUrl = countryId > 0 ? `https://im.mackolik.com/img/groups/${countryId}.gif` : null;

    return {
        fixture: {
            id:        matchId,        // INT
            raw_id:    null,
            referee:   null,
            timezone:  'Europe/Istanbul',
            date:      isoDate,
            timestamp: timestamp,      // INT
            periods:   { first: null, second: null },
            venue:     { id: null, name: null, city: null },
            status:    status,
        },
        league: {
            id:         leagueId,      // INT
            name:       leagueName,
            country:    countryName,
            logo:       leagueLogoUrl, // 🔥 LİG LOGOSU BURADA 🔥
            flag:       null,
            season:     seasonYear,    // INT
            round:      'Regular Season',
            standings:  false
        },
        teams: {
            home: {
                id:     homeId,        // INT
                name:   m[2] || "Unknown",
                logo:   homeLogoUrl,   // 🔥 EV SAHİBİ LOGO BURADA 🔥
                winner: homeWin,
                red_cards: rcHome
            },
            away: {
                id:     awayId,        // INT
                name:   m[4] || "Unknown",
                logo:   awayLogoUrl,   // 🔥 DEPLASMAN LOGO BURADA 🔥
                winner: awayWin,
                red_cards: rcAway
            }
        },
        goals: {
            home: homeGoals, // INT
            away: awayGoals, // INT
        },
        score: {
            halftime:  { home: htHome,    away: htAway    },
            fulltime:  { home: homeGoals, away: awayGoals },
            extratime: { home: null,      away: null      },
            penalty:   { home: null,      away: null      },
        },
        events: [] 
    };
}

// ─── MAÇLARI ÇEK & PARSE ET ───────────────────────────────────────────────────
async function collectMatches(targetDate) {
    const macDate = toMacDate(targetDate);
    log(`  📡 Mackolik API: ${macDate}`);

    const data = await fetchMackolik(macDate);
    const raw  = data.m || [];
    log(`  📦 Ham kayıt: ${raw.length}`);

    const matches = raw
        .map(m => parseMatch(m, targetDate))
        .filter(Boolean);

    log(`  ✅ Parse edilen: ${matches.length} maç`);
    return matches;
}

// ─── FİRESTORE KAYDET ──────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    await db.collection('archive_matches').doc(dateStr).set({
        fixtures:      matches,
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
    }, { merge: true });

    log(`  ✅ ${matches.length} maç → archive_matches/${dateStr}`);

    const leagues = [...new Set(matches.map(m => `${m.league.country}: ${m.league.name}`))];
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0, 6).join(' | ')}${leagues.length > 6 ? ` +${leagues.length - 6}` : ''}`);

    const sports = [...new Set(matches.map(m => m.league.sport))];
    log(`  🏅 Sporlar: ${sports.join(', ')}`);

    const withScore = matches.filter(m => m.goals.home !== null).length;
    log(`  ⚽ Skoru olan: ${withScore}/${matches.length}`);
}

// ─── MAÇ DETAYLARINI (EVENTS) MACKOLİK API'DEN ÇEK ───────────────────────────
function fetchMatchDetails(matchId) {
    return new Promise((resolve) => {
        const url = `https://arsiv.mackolik.com/Match/MatchData.aspx?t=dtl&id=${matchId}&s=0`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json',
                'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/`
            }
        };
        https.get(url, options, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch(e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// 🔥 ROKET VERSİYONU (FLUTTER ENUM ÇÖKMELERİNİ ÖNLEYEN KUSURSUZ YAPI) 🔥
async function enrichMatchEvents(matches) {
    log(`\n🔍 Maç detayları (Events) çekiliyor... Toplam: ${matches.length} maç`);
    
    const CONCURRENCY_LIMIT = 15; 

    for (let i = 0; i < matches.length; i += CONCURRENCY_LIMIT) {
        const chunk = matches.slice(i, i + CONCURRENCY_LIMIT);
        
        await Promise.all(chunk.map(async (match) => {
            const matchId = match.fixture.id;

            // Oynanmamış maçları es geç
            if (['NS', 'PST', 'CANC'].includes(match.fixture.status.short)) {
                return;
            }

            const details = await fetchMatchDetails(matchId);
            
            if (details && details.e && Array.isArray(details.e)) {
                match.events = details.e.map(ev => {
                    const teamCode   = ev[0]; 
                    const minute     = parseInt(ev[1], 10) || 0; 
                    const playerName = ev[3] || '';
                    const typeCode   = ev[4];
                    const extra      = ev[5] || {};

                    const teamSide = teamCode === 1 ? 'home' : 'away';
                    const teamName = teamCode === 1 ? match.teams.home.name : match.teams.away.name;
                    const teamId   = teamCode === 1 ? match.teams.home.id : match.teams.away.id;

                    // 🔥 İŞTE FLUTTER'I ÇÖKMEKTEN KURTARAN MÜDAHALE 🔥
                    let typeStr    = 'Other';
                    let detailStr  = '';
                    let assistName = null;

                    if (typeCode === 1) {
                        typeStr = 'Goal';
                        detailStr = 'Normal Goal';
                        if (extra.astName) assistName = `(${extra.astName})`;
                    } else if (typeCode === 2 || typeCode === 3 || typeCode === 6) {
                        // Sarı ve Kırmızı kartlar KESİNLİKLE "Other" olmalı, yoksa Flutter patlar!
                        typeStr = 'Other';
                        detailStr = '';
                    } else if (typeCode === 4) {
                        // Uygulaman "subst" kelimesini bekliyor
                        typeStr = 'subst';
                        detailStr = 'Substitution';
                        assistName = null; // Senin çalışan JSON'unda buralar hep null'dı
                    }

                    return {
                        minute: minute,
                        minuteExtra: null,
                        type: typeStr,
                        detail: detailStr,
                        playerName: playerName,
                        assistName: assistName,
                        teamSide: teamSide,
                        teamId: teamId,
                        teamName: teamName
                    };
                });
            }
        }));
        
        await sleep(500); 
    }
    
    log(`  ✅ Events başarıyla saniyeler içinde maçlara eklendi.`);
    return matches;
}


// ─── TEK GÜN İŞLE ────────────────────────────────────────────────────────────
async function processDate(db, targetDate) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);

    let matches = await collectMatches(targetDate);

    if (matches.length > 0) {
        // 🔥 İŞTE BURADA EVENTS BİLGİLERİNİ MAÇLARA ENTEGRE EDİYORUZ 🔥
        matches = await enrichMatchEvents(matches);
        
        await saveToFirestore(db, dateStr, matches);
    } else {
        log(`  ❌ Kayıt yok: ${dateStr}`);
    }
}

// ─── ANA AKIŞ ─────────────────────────────────────────────────────────────────
(async () => {
    let db;
    try { db = initFirebase(); }
    catch (e) { logErr('💥 Firebase:', e.message); logFile.end(() => process.exit(1)); return; }

    try {
        if (MODE === 'daily') {
            const y = getYesterday();
            log(`📅 TR dün: ${formatDate(y)}`);
            await processDate(db, y);

        } else if (MODE === 'single') {
            if (!SINGLE) throw new Error('--date gerekli! (YYYY-MM-DD)');
            await processDate(db, parseTargetDate(SINGLE));

        } else if (MODE === 'backfill') {
            if (!FROM_DATE || !TO_DATE) throw new Error('--from ve --to gerekli! (YYYY-MM-DD)');
            const start = parseTargetDate(FROM_DATE);
            const end   = parseTargetDate(TO_DATE);
            const total = Math.round((end - start) / 86400000) + 1;
            log(`🗓️  ${FROM_DATE} → ${TO_DATE} (${total} gün)`);

            for (let i = 0; i < total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate() + i);
                await processDate(db, d);
                if (i < total - 1) await sleep(800 + Math.random() * 400); // API'ya nazik ol
            }
        } else {
            throw new Error(`Bilinmeyen mod: ${MODE}. (daily | single | backfill)`);
        }

    } catch (e) {
        logErr('🔴 KRİTİK HATA:', e.stack || e.message);
        logFile.end(() => process.exit(1));
        return;
    }

    log('\n🏁 Tamamlandı.');
    logFile.end(() => process.exit(0));
})();
