/**
 * ScorePop — Mackolik → Firebase Scraper
 * v3: Rate-limit koruması, stats fallback, sıralı işlem.
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

// ─── RATE LİMİT AYARLARI ─────────────────────────────────────────────────────
// Aynı anda kaç maçın detayı işlensin
const CONCURRENCY   = parseInt(args.concurrency || '2', 10);
// Her maç isteği arasında ms (min-max arası random)
const DELAY_MIN     = parseInt(args.delayMin    || '600',  10);
const DELAY_MAX     = parseInt(args.delayMax    || '1400', 10);
// Stats/standings için ekstra bekleme (bu endpoint'ler daha hassas)
const EXTRA_DELAY   = parseInt(args.extraDelay  || '800',  10);

log('🤖 ScorePop Mackolik Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);
log(`⚡ Concurrency: ${CONCURRENCY} | Delay: ${DELAY_MIN}-${DELAY_MAX}ms`);
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
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const randWait = () => sleep(DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN)));

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
const toMacDate  = d => { const [y, m, day] = formatDate(d).split('-'); return `${day}/${m}/${y}`; };

// ─── HTTP YARDIMCISI ──────────────────────────────────────────────────────────
// Ortak User-Agent havuzu — her istekte rastgele seç
const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

/**
 * Güvenli HTTP GET — retry + 429/5xx koruması
 * @param {string} url
 * @param {object} extraHeaders
 * @param {number} maxRetry
 * @returns {Promise<string>}  ham response body
 */
function httpGet(url, extraHeaders = {}, maxRetry = 3) {
    return new Promise((resolve, reject) => {
        const RETRY_DELAYS = [2000, 5000, 10000];

        const attempt = (tryNum) => {
            const options = {
                headers: {
                    'User-Agent':      randUA(),
                    'Accept':          'text/html,application/json,*/*',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection':      'keep-alive',
                    ...extraHeaders,
                }
            };

            https.get(url, options, res => {
                // 429 Too Many Requests → her zaman retry
                if (res.statusCode === 429) {
                    const retryAfter = parseInt(res.headers['retry-after'] || '10', 10);
                    const delay = Math.max(retryAfter * 1000, RETRY_DELAYS[tryNum - 1] || 10000);
                    log(`  ⏳ 429 Rate-limit (${url.slice(0, 60)}...), ${delay}ms bekleniyor (deneme ${tryNum}/${maxRetry})...`);
                    if (tryNum < maxRetry) { setTimeout(() => attempt(tryNum + 1), delay); return; }
                    reject(new Error(`429 rate-limit aşıldı: ${url}`)); return;
                }

                // 5xx → retry
                if (res.statusCode >= 500) {
                    const delay = RETRY_DELAYS[tryNum - 1] || 5000;
                    if (tryNum < maxRetry) {
                        log(`  🔁 HTTP ${res.statusCode} (${url.slice(0, 60)}...), ${delay}ms retry ${tryNum}/${maxRetry}...`);
                        setTimeout(() => attempt(tryNum + 1), delay);
                        return;
                    }
                    reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return;
                }

                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end',  () => resolve(raw));
            }).on('error', err => {
                const delay = RETRY_DELAYS[tryNum - 1] || 5000;
                if (tryNum < maxRetry) {
                    log(`  🔁 Bağlantı hatası (${err.message}), ${delay}ms retry ${tryNum}/${maxRetry}...`);
                    setTimeout(() => attempt(tryNum + 1), delay);
                } else {
                    reject(err);
                }
            });
        };

        attempt(1);
    });
}

/** JSON gerektiren endpoint'ler için */
async function httpGetJSON(url, extraHeaders = {}) {
    const raw = await httpGet(url, extraHeaders);
    if (raw.trimStart().startsWith('<')) throw new Error(`HTML döndü (sunucu hatası): ${raw.slice(0, 80)}`);
    try { return JSON.parse(raw); }
    catch (e1) {
        try {
            const cleaned = raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\').replace(/[\x00-\x1F\x7F]/g, ' ');
            return JSON.parse(cleaned);
        } catch (e2) {
            throw new Error(`JSON parse hatası: ${e2.message} | ham: ${raw.slice(0, 120)}`);
        }
    }
}

// ─── MACKOLİK ANA API ────────────────────────────────────────────────────────
async function fetchMackolik(dateStr) {
    const url = `https://vd.mackolik.com/livedata?date=${encodeURIComponent(dateStr)}`;
    const data = await httpGetJSON(url, { 'Referer': 'https://arsiv.mackolik.com/' });
    return data;
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

// ─── MAÇ DETAYLARI (Events + Lineups) ────────────────────────────────────────
async function fetchMatchDetails(matchId) {
    const url = `https://arsiv.mackolik.com/Match/MatchData.aspx?t=dtl&id=${matchId}&s=0`;
    try {
        return await httpGetJSON(url, { 'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/` });
    } catch (e) {
        logErr(`  ❌ Details matchId=${matchId}: ${e.message}`);
        return null;
    }
}

// ─── İSTATİSTİKLER ───────────────────────────────────────────────────────────
const STATS_NAME_MAP = {
    'Topla Oynama':    'Ball Possession',
    'Toplam Şut':      'Total Shots',
    'İsabetli Şut':    'Shots on Goal',
    'Başarılı Paslar': 'Passes',
    'Pas Başarı(%)':   'Passes %',
    'Pas Başarı %':    'Passes %',
    'Korner':          'Corner Kicks',
    'Köşe Vuruşu':     'Corner Kicks',
    'Orta':            'Crosses',
    'Faul':            'Fouls',
    'Ofsayt':          'Offsides',
    'Sarı Kart':       'Yellow Cards',
    'Kırmızı Kart':    'Red Cards',
    'Kurtarış':        'Saves',
};

function parseStatsHtml(html) {
    if (!html || html.trim().length < 20) return [];
    const stats  = [];
    const parseVal = v => {
        v = (v || '').trim().replace('%', '');
        if (v.includes('/')) return v;
        const n = parseFloat(v);
        return isNaN(n) ? v : n;
    };

    // ── Pattern 1: team-1-statistics-text / statistics-title-text / team-2-statistics-text ──
    const p1 = /team-1-statistics-text"[^>]*>([\s\S]*?)<\/div>[\s\S]*?statistics-title-text"[^>]*>([\s\S]*?)<\/div>[\s\S]*?team-2-statistics-text"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = p1.exec(html)) !== null) {
        const homeRaw = m[1].replace(/<[^>]+>/g, '').trim();
        const titleTR = m[2].replace(/<[^>]+>/g, '').trim();
        const awayRaw = m[3].replace(/<[^>]+>/g, '').trim();
        const title   = STATS_NAME_MAP[titleTR] || titleTR;
        if (title) stats.push({ type: title, homeVal: parseVal(homeRaw), awayVal: parseVal(awayRaw) });
    }
    if (stats.length > 0) return stats;

    // ── Pattern 2: <td class="team1"> ... <td class="statsName"> ... <td class="team2"> ──
    const p2 = /<td[^>]+class="[^"]*team1[^"]*"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]+class="[^"]*statsName[^"]*"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]+class="[^"]*team2[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    while ((m = p2.exec(html)) !== null) {
        const homeRaw = m[1].replace(/<[^>]+>/g, '').trim();
        const titleTR = m[2].replace(/<[^>]+>/g, '').trim();
        const awayRaw = m[3].replace(/<[^>]+>/g, '').trim();
        const title   = STATS_NAME_MAP[titleTR] || titleTR;
        if (title) stats.push({ type: title, homeVal: parseVal(homeRaw), awayVal: parseVal(awayRaw) });
    }
    if (stats.length > 0) return stats;

    // ── Pattern 3: JSON içinde gömülü stats objesi ──
    const jsonMatch = html.match(/\{[\s\S]*"stats"[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            if (Array.isArray(obj.stats)) {
                return obj.stats.map(s => ({
                    type:    STATS_NAME_MAP[s.name] || s.name || s.type || 'Unknown',
                    homeVal: parseVal(String(s.home ?? s.homeVal ?? '')),
                    awayVal: parseVal(String(s.away ?? s.awayVal ?? '')),
                })).filter(s => s.type !== 'Unknown');
            }
        } catch(_) {}
    }

    // Hiçbir pattern uymadı
    if (html.trim().length > 100) {
        log(`  ⚠️  Stats parse başarısız — ham örnek: ${html.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    return [];
}

async function fetchMatchStats(matchId) {
    const url = `https://arsiv.mackolik.com/AjaxHandlers/MatchHandler.aspx?command=optaStats&id=${matchId}`;
    try {
        const raw = await httpGet(url, { 'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/` });
        return parseStatsHtml(raw);
    } catch (e) {
        logErr(`  ❌ Stats matchId=${matchId}: ${e.message}`);
        return [];
    }
}

// ─── PUAN TABLOSU ─────────────────────────────────────────────────────────────
function parseStandingsHtml(html) {
    const standings = [];
    const rowRegex  = /<tr[^>]+class="row alt[12]"[^>]*>([\s\S]*?)<\/tr>/g;
    let row;
    while ((row = rowRegex.exec(html)) !== null) {
        const block       = row[0];
        const teamIdMatch = block.match(/data-teamid="(\d+)"/);
        if (!teamIdMatch) continue;
        const teamId   = parseInt(teamIdMatch[1], 10);
        const rankMatch = block.match(/<td[^>]*>\s*<b>(\d+)<\/b>\s*<\/td>/);
        if (!rankMatch) continue;
        const rank     = parseInt(rankMatch[1], 10);
        const nameMatch = block.match(/target="_blank"[^>]*>\s*([^<]+?)\s*<\/a>/);
        const name     = nameMatch ? nameMatch[1].trim() : '';
        const nums     = [...block.matchAll(/<td[^>]*align="right"[^>]*>(?:<b>)?(\d+)(?:<\/b>)?<\/td>/g)]
            .map(m => parseInt(m[1], 10));
        if (nums.length < 5) continue;
        const [played, win, draw, lose, points] = nums;
        standings.push({
            rank,
            team: { id: teamId, name, logo: `https://im.mackolik.com/img/logo/buyuk/${teamId}.gif` },
            played, win, draw, lose, points, gf: 0, ga: 0, gd: 0, form: '', description: '',
        });
    }
    return standings;
}

async function fetchMatchStandings(matchId) {
    const url = `https://arsiv.mackolik.com/AjaxHandlers/StandingHandler.aspx?command=matchStanding&id=${matchId}&sv=1`;
    try {
        const raw = await httpGet(url, { 'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/` });
        const result = parseStandingsHtml(raw);
        if (result.length === 0 && raw.trim().length > 100 && !raw.includes('502')) {
            log(`  ⚠️  Standings boş matchId=${matchId} | ham: ${raw.slice(0, 120).replace(/\s+/g, ' ')}`);
        }
        return result;
    } catch (e) {
        logErr(`  ❌ Standings matchId=${matchId}: ${e.message}`);
        return [];
    }
}

// ─── TEK MAÇ PARSE ────────────────────────────────────────────────────────────
/*
  Mackolik m dizisi (test edilmiş, onaylanmış):
  [0]  matchId
  [1]  homeId
  [2]  homeName
  [3]  awayId
  [4]  awayName
  [5]  statusCode      (0=NS, 4=FT, 8=PEN, 9=PST, 20=ET)
  [6]  statusText      ("MS", "Ert." vb.)
  [7]  FINAL skor str  ("2-1")
  [10] kırmızı kart ev  (int)
  [11] kırmızı kart dep (int)
  [12] isabetli şut ev  (int)  ← shots on target, GOALS DEĞİL
  [13] isabetli şut dep (int)  ← shots on target, GOALS DEĞİL
  [16] saat string      ("20:45")
  [18] oran 1  [19] oran X  [20] oran 2
  [29] IY ev gol str    ("1")
  [30] IY dep gol str   ("0")
  [31] FT ev gol str    ("2")  ← gerçek final gol
  [32] FT dep gol str   ("1")  ← gerçek final gol
  [36] [countryId, countryName, leagueId, leagueName, tournId, season, "", ?, ?, leagueCode, ?, sportType]
*/
function parseMatch(m, targetDate) {
    if (!Array.isArray(m) || m.length < 37) return null;

    const li          = Array.isArray(m[36]) ? m[36] : [];
    const sportTypeId = parseInt(li[11], 10) || 1;
    if (sportTypeId !== 1) return null;   // sadece futbol

    const matchId   = parseInt(m[0], 10) || 0;
    const homeId    = parseInt(m[1], 10) || 0;
    const awayId    = parseInt(m[3], 10) || 0;
    const countryId = parseInt(li[0], 10) || 0;
    const leagueId  = parseInt(li[2], 10) || 0;

    const toInt = v => {
        if (v === null || v === undefined || v === '') return null;
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
    };

    // ── GOLLER: m[31] / m[32] (string), fallback m[7] ──
    let homeGoals = toInt(m[31]);
    let awayGoals = toInt(m[32]);
    if (homeGoals === null || awayGoals === null) {
        const scoreStr = typeof m[7] === 'string' ? m[7].trim() : '';
        if (scoreStr.includes('-')) {
            const [h, a] = scoreStr.split('-');
            homeGoals = homeGoals ?? toInt(h);
            awayGoals = awayGoals ?? toInt(a);
        }
    }

    // ── IY: m[29] / m[30] ──
    const htHome = toInt(m[29]);
    const htAway = toInt(m[30]);

    // ── İsabetli şut: m[12] / m[13] ──
    const homeShotsOT = typeof m[12] === 'number' ? m[12] : null;
    const awayShotsOT = typeof m[13] === 'number' ? m[13] : null;

    // ── Kırmızı kart ──
    const rcHome = typeof m[10] === 'number' ? m[10] : 0;
    const rcAway = typeof m[11] === 'number' ? m[11] : 0;

    const statusCode  = parseInt(m[5], 10) || 0;
    const statusText  = typeof m[6] === 'string' ? m[6] : '';
    const status      = parseStatus(statusCode, statusText);

    const countryName = li[1] ?? 'Unknown';
    const leagueName  = li[3] ?? 'Unknown';
    const leagueCode  = li[9] ?? '';
    const seasonYear  = targetDate.getFullYear();
    const dateStr     = formatDate(targetDate);
    const timeStr     = typeof m[16] === 'string' ? m[16] : '00:00';
    const isoDate     = `${dateStr}T${timeStr}:00+03:00`;
    const timestamp   = Math.floor(targetDate.getTime() / 1000);

    const homeWin = homeGoals !== null && awayGoals !== null
        ? (homeGoals > awayGoals ? true : homeGoals === awayGoals ? null : false) : null;
    const awayWin = homeGoals !== null && awayGoals !== null
        ? (awayGoals > homeGoals ? true : homeGoals === awayGoals ? null : false) : null;

    const homeLogoUrl   = homeId    > 0 ? `https://im.mackolik.com/img/logo/buyuk/${homeId}.gif`  : null;
    const awayLogoUrl   = awayId    > 0 ? `https://im.mackolik.com/img/logo/buyuk/${awayId}.gif`  : null;
    const leagueLogoUrl = countryId > 0 ? `https://im.mackolik.com/img/groups/${countryId}.gif`   : null;

    // İsabetli şutu başlangıç stats'ına koy; enrichMatchEvents'te optaStats ile genişler
    const initialStats = homeShotsOT !== null ? [{
        type: 'Shots on Goal', homeVal: homeShotsOT, awayVal: awayShotsOT ?? 0,
    }] : [];

    return {
        fixture: {
            id: matchId, raw_id: null, referee: null,
            timezone: 'Europe/Istanbul', date: isoDate, timestamp,
            periods: { first: null, second: null },
            venue: { id: null, name: null, city: null },
            status,
        },
        league: {
            id: leagueId, name: leagueName, country: countryName,
            logo: leagueLogoUrl, flag: null, season: seasonYear,
            round: 'Regular Season', standings: false, code: leagueCode,
        },
        teams: {
            home: { id: homeId, name: m[2] || 'Unknown', logo: homeLogoUrl, winner: homeWin, red_cards: rcHome },
            away: { id: awayId, name: m[4] || 'Unknown', logo: awayLogoUrl, winner: awayWin, red_cards: rcAway },
        },
        goals: { home: homeGoals, away: awayGoals },
        score: {
            halftime:  { home: htHome,    away: htAway    },
            fulltime:  { home: homeGoals, away: awayGoals },
            extratime: { home: null,      away: null      },
            penalty:   { home: null,      away: null      },
        },
        events:    [],
        standings: [],
        stats:     initialStats,
        lineups: {
            home: { startXI: [], substitutes: [] },
            away: { startXI: [], substitutes: [] },
        },
    };
}

// ─── EVENTS + LINEUPS + STATS + STANDINGS ENRİCH ─────────────────────────────
async function enrichMatchEvents(matches) {
    log(`\n🔍 Detaylar çekiliyor... ${matches.length} maç`);

    const eligible = matches.filter(m => !['NS', 'PST', 'CANC'].includes(m.fixture.status.short));
    log(`  📌 Uygun maç: ${eligible.length} | Concurrency: ${CONCURRENCY}`);

    const parsePlayers = (arr, count) => {
        if (!Array.isArray(arr)) return { startXI: [], substitutes: [] };
        const players = arr.map(p => ({ id: Number(p[0]) || 0, name: String(p[1] || ''), number: Number(p[2]) || 0 }));
        return { startXI: players.slice(0, count), substitutes: players.slice(count) };
    };

    let fetchedEvents = 0, emptyEvents = 0, failedDetails = 0;
    let fetchedStats  = 0, failedStats  = 0;
    let fetchedStand  = 0, failedStand  = 0;

    // ── Sıralı mini-batch işlem ──────────────────────────────────────────────
    // Her batch'te CONCURRENCY kadar maç, batch'ler arasında randWait()
    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
        const batch = eligible.slice(i, i + CONCURRENCY);
        const batchNum = Math.floor(i / CONCURRENCY) + 1;
        const totalBatches = Math.ceil(eligible.length / CONCURRENCY);

        log(`  📦 Batch ${batchNum}/${totalBatches} (maç ${i + 1}-${Math.min(i + CONCURRENCY, eligible.length)})`);

        // Batch içi paralel — ama her maç için sırayla 3 endpoint çağrılır (paralel değil)
        await Promise.all(batch.map(async (match) => {
            const matchId = match.fixture.id;

            // ── 1. DETAILS (events + lineups) ──
            const details = await fetchMatchDetails(matchId);
            if (!details) {
                failedDetails++;
            } else {
                match.lineups = { home: parsePlayers(details.h, 11), away: parsePlayers(details.a, 11) };

                if (Array.isArray(details.e) && details.e.length > 0) {
                    fetchedEvents++;
                    match.events = details.e.map(ev => {
                        const teamCode   = ev[0];
                        const minute     = ev[1];
                        const playerName = ev[3];
                        const typeCode   = ev[4];
                        const extra      = ev[5] || {};
                        const teamSide   = teamCode === 1 ? 'home' : 'away';
                        const teamName   = teamCode === 1 ? match.teams.home.name : match.teams.away.name;

                        let typeStr = 'Other', detailStr = '', assistName = null;
                        switch (typeCode) {
                            case 1: typeStr = 'Goal';  detailStr = 'Normal Goal';     if (extra.astName) assistName = extra.astName; break;
                            case 2: typeStr = 'Card';  detailStr = 'Yellow Card';     break;
                            case 3: typeStr = 'Card';  detailStr = 'Red Card';        break;
                            case 6: typeStr = 'Card';  detailStr = 'Yellow Red Card'; break;
                            case 4: typeStr = 'subst'; detailStr = 'Substitution';    break;
                        }
                        return {
                            minute:      Number(minute) || 0,
                            minuteExtra: null,
                            type:        typeStr,
                            detail:      detailStr,
                            playerName:  playerName ? String(playerName) : '',
                            assistName:  assistName ? String(assistName) : null,
                            teamSide,
                            teamId:      0,
                            teamName,
                        };
                    });
                } else {
                    emptyEvents++;
                }
            }

            // ── 2. STATS — ayrı endpoint, ekstra bekleme ──
            await sleep(EXTRA_DELAY + Math.floor(Math.random() * 400));
            const statsResult = await fetchMatchStats(matchId);
            if (statsResult.length > 0) {
                // optaStats varsa, initialStats'ı (sadece shots) değiştir
                match.stats = statsResult;
                fetchedStats++;
            } else {
                // optaStats boş → initialStats (shots on target) kalsın
                failedStats++;
            }

            // ── 3. STANDINGS — en hassas endpoint, en uzun bekleme ──
            await sleep(EXTRA_DELAY + Math.floor(Math.random() * 600));
            const standResult = await fetchMatchStandings(matchId);
            if (standResult.length > 0) {
                match.standings = standResult;
                fetchedStand++;
            } else {
                failedStand++;
            }
        }));

        // Batch'ler arası bekleme (son batch hariç)
        if (i + CONCURRENCY < eligible.length) await randWait();
    }

    log(`  ✅ Events  → dolu: ${fetchedEvents} | boş: ${emptyEvents} | hata: ${failedDetails}`);
    log(`  ✅ Stats   → dolu: ${fetchedStats} | boş/hata: ${failedStats}`);
    log(`  ✅ Stands  → dolu: ${fetchedStand} | boş/hata: ${failedStand}`);
    return matches;
}

// ─── MAÇLARI ÇEK & PARSE ET ──────────────────────────────────────────────────
async function collectMatches(targetDate) {
    const macDate = toMacDate(targetDate);
    log(`  📡 Mackolik API: ${macDate}`);

    const data = await fetchMackolik(macDate);
    const raw  = data.m || [];
    log(`  📦 Ham kayıt: ${raw.length}`);

    const all     = raw.map(m => parseMatch(m, targetDate)).filter(Boolean);
    const matches = all.filter(m => ['FT', 'AET', 'PEN'].includes(m.fixture.status.short));
    const skipped = all.length - matches.length;

    log(`  ✅ Parse edilen: ${all.length} | Bitmemiş atlandı: ${skipped} | Kaydedilecek: ${matches.length}`);
    return matches;
}

// ─── FİRESTORE KAYDET ────────────────────────────────────────────────────────
async function saveToFirestore(db, dateStr, matches) {
    const dateRef = db.collection('archive_matches').doc(dateStr);

    await dateRef.set({
        last_updated:  new Date().toISOString(),
        total_matches: matches.length,
        match_ids:     matches.map(m => m.fixture.id),
    }, { merge: true });

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
        if (written % 50 === 0 && written > 0) {
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

    log(`\n  ✅ ${written}/${matches.length} maç → archive_matches/${dateStr}/fixtures/`);
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0, 6).join(' | ')}${leagues.length > 6 ? ` +${leagues.length - 6}` : ''}`);
    log(`  ⚽ Skoru olan: ${withScore}/${matches.length}`);
    log(`  🎯 Events: ${withEvents}/${matches.length} (toplam ${totalEvents})`);
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
            if (start > end) {
                log(`⚠️  from > to, otomatik düzeltildi`);
                [start, end] = [end, start];
            }
            const total = Math.round((end - start) / 86400000) + 1;
            log(`🗓️  ${formatDate(start)} → ${formatDate(end)} (${total} gün)`);
            for (let i = 0; i < total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate() + i);
                await processDate(db, d);
                if (i < total - 1) await sleep(2000 + Math.random() * 1000);
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
