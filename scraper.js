/**
 * ScorePop — Mackolik → Firebase Scraper
 * v2: Alt koleksiyon yapısı (1MB limit yok), lineups desteği.
 *
 * Kullanım:
 *   node scraper.js --mode=daily
 *   node scraper.js --mode=single --date=2026-02-24
 *   node scraper.js --mode=backfill --from=2026-02-01 --to=2026-02-28
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

const formatDate = d => d.toISOString().split('T')[0];

const toMacDate = d => {
    const [y, m, day] = formatDate(d).split('-');
    return `${day}/${m}/${y}`;
};

// ─── MACKOLİK API ─────────────────────────────────────────────────────────────
function fetchMackolik(dateStr) {
    return new Promise((resolve, reject) => {
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

// ─── STATUS PARSE ─────────────────────────────────────────────────────────────
function parseStatus(statusCode, statusText) {
    const map = {
        0:  { long: 'Not Started',    short: 'NS',  elapsed: null },
        4:  { long: 'Match Finished', short: 'FT',  elapsed: 90   },
        8:  { long: 'Match Finished', short: 'PEN', elapsed: 120  },
        9:  { long: 'Postponed',      short: 'PST', elapsed: null },
        20: { long: 'Extra Time',     short: 'ET',  elapsed: 105  },
        13: { long: 'Match Finished', short: 'FT',  elapsed: null },
    };
    return { ...(map[statusCode] || { long: statusText || 'Unknown', short: 'UN', elapsed: null }), extra: null };
}

// ─── İSTATİSTİKLERİ ÇEK (HTML parse) ────────────────────────────────────────
function fetchMatchStats(matchId) {
    return new Promise((resolve) => {
        const url = `https://arsiv.mackolik.com/AjaxHandlers/MatchHandler.aspx?command=optaStats&id=${matchId}`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept':     'text/html',
                'Referer':    `https://arsiv.mackolik.com/Mac/${matchId}/`,
            }
        };
        https.get(url, options, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    resolve(parseStatsHtml(raw));
                } catch(e) {
                    logErr(`  ❌ Stats parse hatası matchId=${matchId}: ${e.message}`);
                    resolve([]);
                }
            });
        }).on('error', () => resolve([]));
    });
}

// ─── PUAN TABLOSUNU ÇEK ──────────────────────────────────────────────────────
function fetchMatchStandings(matchId) {
    return new Promise((resolve) => {
        const url = `https://arsiv.mackolik.com/AjaxHandlers/StandingHandler.aspx?command=matchStanding&id=${matchId}&sv=1`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept':     'text/html',
                'Referer':    `https://arsiv.mackolik.com/Mac/${matchId}/`,
            }
        };

        const MAX_RETRY   = 3;
        const RETRY_DELAY = [1000, 2500, 5000];

        const attempt = (tryNum) => {
            https.get(url, options, res => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                    // ── 502 retry ──
                    if (raw.includes('502 Bad Gateway') || raw.includes('503 Service')) {
                        if (tryNum < MAX_RETRY) {
                            const delay = RETRY_DELAY[tryNum - 1] || 5000;
                            log(`  🔁 Standings 502 matchId=${matchId}, ${delay}ms retry ${tryNum}/${MAX_RETRY}...`);
                            setTimeout(() => attempt(tryNum + 1), delay);
                            return;
                        }
                        logErr(`  ❌ Standings 502 matchId=${matchId} (deneme ${tryNum})`);
                        resolve([]);
                        return;
                    }

                    try {
                        const result = parseStandingsHtml(raw);
                        if (result.length === 0 && raw.trim().length > 0 && !raw.includes('502')) {
                            log(`  ⚠️  Standings boş matchId=${matchId} | ham: ${raw.slice(0, 150).replace(/\s+/g, ' ')}`);
                        }
                        resolve(result);
                    } catch(e) {
                        logErr(`  ❌ Standings parse hatası matchId=${matchId}: ${e.message}`);
                        resolve([]);
                    }
                });
            }).on('error', err => {
                if (tryNum < MAX_RETRY) {
                    const delay = RETRY_DELAY[tryNum - 1] || 5000;
                    setTimeout(() => attempt(tryNum + 1), delay);
                } else {
                    resolve([]);
                }
            });
        };

        attempt(1);
    });
}

function parseStandingsHtml(html) {
    const standings = [];

    // data-teamid her yerde olabilir, sıra önemli değil
    const rowRegex = /<tr[^>]+class="row alt[12]"[^>]*>([\s\S]*?)<\/tr>/g;
    let row;

    while ((row = rowRegex.exec(html)) !== null) {
        const block = row[0];

        // teamId — iki olası konum
        const teamIdMatch = block.match(/data-teamid="(\d+)"/);
        if (!teamIdMatch) continue;
        const teamId = parseInt(teamIdMatch[1], 10);

        // Sıra
        const rankMatch = block.match(/<td[^>]*>\s*<b>(\d+)<\/b>\s*<\/td>/);
        if (!rankMatch) continue;
        const rank = parseInt(rankMatch[1], 10);

        // Takım adı — href içindeki text
        const nameMatch = block.match(/target="_blank"[^>]*>\s*([^<]+?)\s*<\/a>/);
        const name = nameMatch ? nameMatch[1].trim() : '';

        // Sayısal sütunlar: O G B M P
        // Sayısal sütunlar: O G B M P  (P <b> ile sarılı olabilir)
        const nums = [...block.matchAll(/<td[^>]*align="right"[^>]*>(?:<b>)?(\d+)(?:<\/b>)?<\/td>/g)]
       .map(m => parseInt(m[1], 10));

        if (nums.length < 5) continue;

        const [played, win, draw, lose, points] = nums;

        standings.push({
            rank,
            team: {
                id:   teamId,
                name: name,
                logo: `https://im.mackolik.com/img/logo/buyuk/${teamId}.gif`,
            },
            played, win, draw, lose, points,
            gf: 0, ga: 0, gd: 0,
            form: '', description: '',
        });
    }

    return standings;
}

function parseStatsHtml(html) {
    const stats = [];

    // İsim → İngilizce karşılığı (Flutter tarafıyla uyumlu)
    const nameMap = {
        'Topla Oynama':   'Ball Possession',
        'Toplam Şut':     'Total Shots',
        'İsabetli Şut':   'Shots on Goal',
        'Başarılı Paslar':'Passes',
        'Pas Başarı(%)':  'Passes %',
        'Korner':         'Corner Kicks',
        'Orta':           'Crosses',
        'Faul':           'Fouls',
        'Ofsayt':         'Offsides',
    };

    // Her satırı bul: team-1-text | title | team-2-text
    const rowRegex = /team-1-statistics-text">(.*?)<\/div>.*?statistics-title-text">(.*?)<\/div>.*?team-2-statistics-text">(.*?)<\/div>/gs;
    let match;

    while ((match = rowRegex.exec(html)) !== null) {
        const homeRaw = match[1].trim().replace('%', '');
        const titleTR = match[2].trim();
        const awayRaw = match[3].trim().replace('%', '');

        const title = nameMap[titleTR] || titleTR;

        // Sayısal değere çevir (4/13 gibi oran varsa string bırak)
        const parseVal = v => {
            if (v.includes('/')) return v; // "4/13" gibi oran → string
            const n = parseFloat(v);
            return isNaN(n) ? v : n;
        };

        stats.push({
            type:    title,
            homeVal: parseVal(homeRaw),
            awayVal: parseVal(awayRaw),
        });
    }

    return stats;
}

// ─── TEK MAÇ PARSE ────────────────────────────────────────────────────────────
function parseMatch(m, targetDate) {
    if (!Array.isArray(m) || m.length < 37) return null;

    const li = Array.isArray(m[36]) ? m[36] : [];
    const sportTypeId = parseInt(li[11], 10) || 1;
    if (sportTypeId !== 1) return null;

    const matchId    = parseInt(m[0], 10) || 0;
    const homeId     = parseInt(m[1], 10) || 0;
    const awayId     = parseInt(m[3], 10) || 0;
    const countryId  = parseInt(li[0], 10) || 0;
    const leagueId   = parseInt(li[2], 10) || 0;
    const seasonYear = targetDate.getFullYear();

    const toInt = v => {
        if (v === null || v === undefined || v === '') return null;
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
    };

    const homeGoals = toInt(m[12]);
    const awayGoals = toInt(m[13]);

    let htHome = null, htAway = null;
    const htStr = typeof m[7] === 'string' ? m[7].replace(/\s/g, '') : '';
    if (htStr.includes('-')) {
        const parts = htStr.split('-');
        htHome = toInt(parts[0]);
        htAway = toInt(parts[1]);
    }

    const statusCode = parseInt(m[5], 10) || 0;
    const statusText = typeof m[6] === 'string' ? m[6] : '';
    const status     = parseStatus(statusCode, statusText);

    const countryName   = li[1] ?? 'Unknown';
    const leagueName    = li[3] ?? 'Unknown';
    const dateStr       = formatDate(targetDate);
    const timeStr       = typeof m[16] === 'string' ? m[16] : '00:00';
    const isoDate       = `${dateStr}T${timeStr}:00+03:00`;
    const timestamp     = Math.floor(targetDate.getTime() / 1000);

    const homeWin = homeGoals !== null && awayGoals !== null
        ? (homeGoals > awayGoals ? true : homeGoals === awayGoals ? null : false) : null;
    const awayWin = homeGoals !== null && awayGoals !== null
        ? (awayGoals > homeGoals ? true : homeGoals === awayGoals ? null : false) : null;

    const homeLogoUrl   = homeId   > 0 ? `https://im.mackolik.com/img/logo/buyuk/${homeId}.gif` : null;
    const awayLogoUrl   = awayId   > 0 ? `https://im.mackolik.com/img/logo/buyuk/${awayId}.gif` : null;
    const leagueLogoUrl = countryId > 0 ? `https://im.mackolik.com/img/groups/${countryId}.gif`  : null;

    return {
        fixture: {
            id:        matchId,
            raw_id:    null,
            referee:   null,
            timezone:  'Europe/Istanbul',
            date:      isoDate,
            timestamp: timestamp,
            periods:   { first: null, second: null },
            venue:     { id: null, name: null, city: null },
            status:    status,
        },
        league: {
            id:        leagueId,
            name:      leagueName,
            country:   countryName,
            logo:      leagueLogoUrl,
            flag:      null,
            season:    seasonYear,
            round:     'Regular Season',
            standings: false,
        },
        teams: {
            home: { id: 0, name: m[2] || 'Unknown', logo: homeLogoUrl, winner: homeWin },
            away: { id: 0, name: m[4] || 'Unknown', logo: awayLogoUrl, winner: awayWin },
        },
        goals: { home: homeGoals, away: awayGoals },
        score: {
            halftime:  { home: htHome,    away: htAway    },
            fulltime:  { home: homeGoals, away: awayGoals },
            extratime: { home: null,      away: null      },
            penalty:   { home: null,      away: null      },
        },
        events:  [],
        standings: [],
        stats:     [],
        // ── enrichMatchEvents tarafından doldurulur ──
        lineups: {
            home: { startXI: [], substitutes: [] },
            away: { startXI: [], substitutes: [] },
        },
    };
}

// ─── MAÇ DETAYLARINI (EVENTS + LINEUPS) MACKOLİK API'DEN ÇEK ────────────────
function fetchMatchDetails(matchId) {
    return new Promise((resolve) => {
        const url = `https://arsiv.mackolik.com/Match/MatchData.aspx?t=dtl&id=${matchId}&s=0`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept':     'application/json',
                'Referer':    `https://arsiv.mackolik.com/Mac/${matchId}/`,
            }
        };

        const MAX_RETRY   = 3;
        const RETRY_DELAY = [1000, 2500, 5000];

        const attempt = (tryNum) => {
            https.get(url, options, res => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {

                    // ── HTML / 502 hata sayfası ──
                    if (raw.trimStart().startsWith('<')) {
                        const isGatewayErr = res.statusCode >= 500
                            || raw.includes('Bad Gateway')
                            || raw.includes('Service Unavailable');
                        if (isGatewayErr && tryNum < MAX_RETRY) {
                            const delay = RETRY_DELAY[tryNum - 1] || 5000;
                            log(`  🔁 ${res.statusCode} matchId=${matchId}, ${delay}ms retry ${tryNum}/${MAX_RETRY}...`);
                            setTimeout(() => attempt(tryNum + 1), delay);
                            return;
                        }
                        logErr(`  ❌ Sunucu hatası matchId=${matchId} (deneme ${tryNum}): HTTP ${res.statusCode}`);
                        resolve(null);
                        return;
                    }

                    // ── JSON parse: önce direkt, başarısız olursa temizleyerek ──
                    try {
                        resolve(JSON.parse(raw));
                    } catch (e1) {
                        try {
                            const cleaned = raw
                                .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
                                .replace(/[\x00-\x1F\x7F]/g, ' ');
                            const parsed = JSON.parse(cleaned);
                            log(`  🔧 JSON onarıldı: matchId=${matchId}`);
                            resolve(parsed);
                        } catch (e2) {
                            logErr(`  ❌ JSON parse hatası matchId=${matchId}: ${e2.message} | ham: ${raw.slice(0, 120)}`);
                            resolve(null);
                        }
                    }
                });
            }).on('error', err => {
                if (tryNum < MAX_RETRY) {
                    const delay = RETRY_DELAY[tryNum - 1] || 5000;
                    log(`  🔁 Bağlantı hatası matchId=${matchId} (${err.message}), ${delay}ms retry ${tryNum}/${MAX_RETRY}...`);
                    setTimeout(() => attempt(tryNum + 1), delay);
                } else {
                    logErr(`  ❌ HTTP hatası matchId=${matchId}: ${err.message}`);
                    resolve(null);
                }
            });
        };

        attempt(1);
    });
}

// ─── EVENTS + LINEUPS ENRİCH ──────────────────────────────────────────────────
async function enrichMatchEvents(matches) {
    log(`\n🔍 Events + Lineups çekiliyor... Toplam: ${matches.length} maç`);

    const eligible = matches.filter(m => !['NS', 'PST', 'CANC'].includes(m.fixture.status.short));
    log(`  📌 Uygun maç (NS/PST/CANC dışı): ${eligible.length}`);

    const parsePlayers = (arr, count) => {
        if (!Array.isArray(arr)) return { startXI: [], substitutes: [] };
        const players = arr.map(p => ({
            id:     Number(p[0]) || 0,
            name:   String(p[1] || ''),
            number: Number(p[2]) || 0,
        }));
        return {
            startXI:     players.slice(0, count),
            substitutes: players.slice(count),
        };
    };

    const CONCURRENCY_LIMIT = 5;
    let fetchedCount = 0;
    let emptyCount   = 0;
    let failedCount  = 0;

    for (let i = 0; i < eligible.length; i += CONCURRENCY_LIMIT) {
        const chunk = eligible.slice(i, i + CONCURRENCY_LIMIT);

        await Promise.all(chunk.map(async (match) => {
            const matchId = match.fixture.id;
            const details = await fetchMatchDetails(matchId);

            if (!details) {
                failedCount++;
                return;
            }

            // ── Lineup: details geldiği sürece kaydet ──
            match.lineups = {
                home: parsePlayers(details.h, 11),
                away: parsePlayers(details.a, 11),
            };

            // ── Stats (ayrı endpoint) ──
            match.stats = await fetchMatchStats(matchId);

            // ── Standings ──
            match.standings = await fetchMatchStandings(matchId);

            // ── Events ──
            if (!details.e || !Array.isArray(details.e) || details.e.length === 0) {
                emptyCount++;
                return;
            }

            fetchedCount++;

            match.events = details.e.map(ev => {
                const teamCode   = ev[0];
                const minute     = ev[1];
                const playerName = ev[3];
                const typeCode   = ev[4];
                const extra      = ev[5] || {};

                const teamSide = teamCode === 1 ? 'home' : 'away';
                const teamName = teamCode === 1 ? match.teams.home.name : match.teams.away.name;

                let typeStr    = 'Other';
                let detailStr  = '';
                let assistName = null;

                switch (typeCode) {
                    case 1:
                        typeStr    = 'Goal';
                        detailStr  = 'Normal Goal';
                        if (extra.astName) assistName = `(${extra.astName})`;
                        break;
                    case 2:  typeStr = 'Card';  detailStr = 'Yellow Card';      break;
                    case 3:  typeStr = 'Card';  detailStr = 'Red Card';         break;
                    case 6:  typeStr = 'Card';  detailStr = 'Yellow Red Card';  break;
                    case 4:  typeStr = 'subst'; detailStr = 'Substitution';     break;
                    default: typeStr = 'Other'; detailStr = '';                 break;
                }

                return {
                    minute:      Number(minute) || 0,
                    minuteExtra: null,
                    type:        String(typeStr),
                    detail:      String(detailStr),
                    playerName:  playerName ? String(playerName) : '',
                    assistName:  assistName ? String(assistName) : null,
                    teamSide:    String(teamSide),
                    teamId:      0,
                    teamName:    String(teamName),
                };
            });
        }));

        if (i + CONCURRENCY_LIMIT < eligible.length) await sleep(500);
    }

    log(`  ✅ Tamamlandı → Events dolu: ${fetchedCount} | Boş: ${emptyCount} | Hata: ${failedCount}`);
    return matches;
}

// ─── MAÇLARI ÇEK & PARSE ET ──────────────────────────────────────────────────
async function collectMatches(targetDate) {
    const macDate = toMacDate(targetDate);
    log(`  📡 Mackolik API: ${macDate}`);

    const data = await fetchMackolik(macDate);
    const raw  = data.m || [];
    log(`  📦 Ham kayıt: ${raw.length}`);

    const all = raw.map(m => parseMatch(m, targetDate)).filter(Boolean);
    
    // ── Sadece biten maçları kaydet ──
    const matches = all.filter(m => ['FT', 'AET', 'PEN'].includes(m.fixture.status.short));
    const skipped = all.length - matches.length;
    
    log(`  ✅ Parse edilen: ${all.length} maç`);
    if (skipped > 0) log(`  ⏭️  Atlandı (bitmemiş): ${skipped} maç`);
    log(`  💾 Kaydedilecek (FT/AET/PEN): ${matches.length} maç`);
    
    return matches;
}

// ─── FİRESTORE KAYDET ────────────────────────────────────────────────────────
// Yapı: archive_matches/{date}/fixtures/{matchId}
// Her maç ayrı döküman → 1MB limit yok, backfill güvenle çalışır.
async function saveToFirestore(db, dateStr, matches) {
    const dateRef = db.collection('archive_matches').doc(dateStr);

    // Index dökümanı
    await dateRef.set({
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
        match_ids:     matches.map(m => m.fixture.id),
    }, { merge: true });

    // ── Her maçı ayrı ayrı yaz (batch timeout sorununu çözer) ──
    let written = 0;
    for (const match of matches) {
        const ref = dateRef.collection('fixtures').doc(String(match.fixture.id));
        let attempt = 1;
        while (attempt <= 3) {
            try {
                await ref.set(match);
                written++;
                break;
            } catch (err) {
                if (attempt < 3 && (err.code === 4 || err.message.includes('DEADLINE_EXCEEDED') || err.message.includes('UNAVAILABLE'))) {
                    const delay = attempt * 3000;
                    log(`  🔁 Firestore timeout matchId=${match.fixture.id}, ${delay}ms retry ${attempt}/3...`);
                    await sleep(delay);
                    attempt++;
                } else {
                    logErr(`  ❌ Firestore yazma hatası matchId=${match.fixture.id}: ${err.message}`);
                    break;
                }
            }
        }

        // Her 50 yazımda bir kısa mola
        if (written % 50 === 0) {
            log(`  💾 Yazıldı: ${written}/${matches.length}`);
            await sleep(300);
        }
    }

    const leagues       = [...new Set(matches.map(m => `${m.league.country}: ${m.league.name}`))];
    const withScore     = matches.filter(m => m.goals.home !== null).length;
    const withEvents    = matches.filter(m => m.events?.length > 0).length;
    const withLineups   = matches.filter(m => m.lineups?.home?.startXI?.length > 0).length;
    const withStats     = matches.filter(m => m.stats?.length > 0).length;
    const withStandings = matches.filter(m => m.standings?.length > 0).length;
    const totalEvents   = matches.reduce((s, m) => s + (m.events?.length || 0), 0);

    log(`  ✅ ${written}/${matches.length} maç → archive_matches/${dateStr}/fixtures/`);
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0,6).join(' | ')}${leagues.length > 6 ? ` +${leagues.length-6}` : ''}`);
    log(`  ⚽ Skoru olan: ${withScore}/${matches.length}`);
    log(`  🎯 Events: ${withEvents}/${matches.length} | Toplam: ${totalEvents}`);
    log(`  👕 Lineup: ${withLineups}/${matches.length}`);
    log(`  📊 Stats: ${withStats}/${matches.length}`);
    log(`  🏆 Standings: ${withStandings}/${matches.length}`);
}

// ─── TEK GÜN İŞLE ────────────────────────────────────────────────────────────
async function processDate(db, targetDate) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);

    let matches = await collectMatches(targetDate);

    if (matches.length > 0) {
        matches = await enrichMatchEvents(matches);
        await saveToFirestore(db, dateStr, matches);
    } else {
        log(`  ❌ Kayıt yok: ${dateStr}`);
    }
}

// ─── ANA AKIŞ ────────────────────────────────────────────────────────────────
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
    let start = parseTargetDate(FROM_DATE);
    let end   = parseTargetDate(TO_DATE);

    // ── Ters yazılmışsa otomatik düzelt ──
    if (start > end) {
        log(`⚠️  from > to, otomatik düzeltildi: ${formatDate(end)} → ${formatDate(start)}`);
        [start, end] = [end, start];
    }

    const total = Math.round((end - start) / 86400000) + 1;
    log(`🗓️  ${formatDate(start)} → ${formatDate(end)} (${total} gün)`);

    for (let i = 0; i < total; i++) {
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + i);
        await processDate(db, d);
        if (i < total - 1) await sleep(1000 + Math.random() * 500);
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
