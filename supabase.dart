/**
 * ScorePop — Mackolik → Supabase Scraper
 * v5: Firebase → Supabase migration. Tablo yapısı arsiv_events ile uyumlu.
 *
 * Kullanım:
 *   node scraper_supabase.js --mode=daily
 *   node scraper_supabase.js --mode=single --date=2026-02-24
 *   node scraper_supabase.js --mode=backfill --from=2026-02-01 --to=2026-02-28
 *
 * Opsiyonel parametreler:
 *   --concurrency=2   Aynı anda işlenecek maç sayısı
 *   --delayMin=600    Batch arası min bekleme (ms)
 *   --delayMax=1400   Batch arası max bekleme (ms)
 *   --extraDelay=800  Stats/standings öncesi ek bekleme (ms)
 *   --skipStats       Stats çekmeyi atla (hız için)
 *   --skipStandings   Standings çekmeyi atla (hız için)
 *
 * Supabase tabloları (SQL aşağıda):
 *
 *   create table arsiv_matches (
 *     match_id        bigint primary key,
 *     date            text,
 *     timestamp       bigint,
 *     status_short    text,
 *     status_long     text,
 *     home_team_id    bigint,
 *     home_team_name  text,
 *     home_team_logo  text,
 *     away_team_id    bigint,
 *     away_team_name  text,
 *     away_team_logo  text,
 *     home_goals      int,
 *     away_goals      int,
 *     ht_home         int,
 *     ht_away         int,
 *     league_id       bigint,
 *     league_name     text,
 *     league_country  text,
 *     league_season   int,
 *     league_code     text,
 *     created_at      timestamptz default now()
 *   );
 *
 *   -- arsiv_events zaten mevcut, yapısı korunuyor:
 *   -- id, match_id, minute, minute_extra, type, detail,
 *   -- player_name, assist_name, team_side, team_id, team_name
 *
 *   create table arsiv_stats (
 *     id        bigserial primary key,
 *     match_id  bigint,
 *     type      text,
 *     home_val  text,
 *     away_val  text
 *   );
 *
 *   create table arsiv_standings (
 *     id         bigserial primary key,
 *     match_id   bigint,
 *     rank       int,
 *     team_id    bigint,
 *     team_name  text,
 *     played     int,
 *     win        int,
 *     draw       int,
 *     lose       int,
 *     points     int
 *   );
 *
 *   create table arsiv_lineups (
 *     id             bigserial primary key,
 *     match_id       bigint,
 *     team_side      text,
 *     player_id      bigint,
 *     player_name    text,
 *     player_number  int,
 *     is_starter     boolean
 *   );
 *
 *   create table arsiv_h2h (
 *     id            bigserial primary key,
 *     match_id      bigint,
 *     record_type   text,   -- 'h2h' | 'home_form' | 'away_form'
 *     h2h_match_id  bigint,
 *     date          text,
 *     home_team     text,
 *     away_team     text,
 *     home_goals    int,
 *     away_goals    int,
 *     ht_home       int,
 *     ht_away       int,
 *     home_winner   boolean,
 *     result        text    -- form için: W/D/L
 *   );
 *
 *   create table arsiv_scorers (
 *     id         bigserial primary key,
 *     match_id   bigint,
 *     team_side  text,
 *     name       text,
 *     goals      int
 *   );
 */

const https  = require('https');
const zlib   = require('zlib');
const fs     = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ─── LOG ─────────────────────────────────────────────────────────────────────
const logFile = fs.createWriteStream('scraper.log', { flags: 'w' });
function log(...a)    { const m = a.join(' '); console.log(m);   logFile.write(m + '\n'); }
function logErr(...a) { const m = a.join(' '); console.error(m); logFile.write('[ERR] ' + m + '\n'); }

process.on('uncaughtException',  e => { logErr('💥 UNCAUGHT:',   e.stack || e.message); logFile.end(() => process.exit(1)); });
process.on('unhandledRejection', e => { logErr('💥 REJECTION:', e?.stack || e);          logFile.end(() => process.exit(1)); });

// ─── ARGS ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.length ? v.join('=') : 'true'];
    })
);
const MODE           = args.mode          || 'daily';
const SINGLE         = args.date          || null;
const FROM_DATE      = args.from          || null;
const TO_DATE        = args.to            || null;
const CONCURRENCY    = parseInt(args.concurrency  || '2',    10);
const DELAY_MIN      = parseInt(args.delayMin      || '600',  10);
const DELAY_MAX      = parseInt(args.delayMax      || '1400', 10);
const EXTRA_DELAY    = parseInt(args.extraDelay    || '800',  10);
const SKIP_STATS     = args.skipStats     === 'true';
const SKIP_STANDINGS = args.skipStandings === 'true';

log('🤖 ScorePop Mackolik Botu Başlatılıyor...');
log(`📋 Mod: ${MODE.toUpperCase()}${SINGLE ? ` | Tarih: ${SINGLE}` : ''}`);
log(`⚡ Concurrency: ${CONCURRENCY} | Delay: ${DELAY_MIN}-${DELAY_MAX}ms | ExtraDelay: ${EXTRA_DELAY}ms`);
log(`🔧 Node: ${process.version} | Stats: ${SKIP_STATS ? 'ATLA' : 'ÇEK'} | Standings: ${SKIP_STANDINGS ? 'ATLA' : 'ÇEK'}`);

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
function initSupabase() {
    log('🟢 Supabase başlatılıyor...');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;   // service_role key (RLS bypass için)
    if (!url) throw new Error('SUPABASE_URL bulunamadı!');
    if (!key) throw new Error('SUPABASE_KEY bulunamadı!');
    const client = createClient(url, key, {
        auth: { persistSession: false },
    });
    log(`   ✓ Supabase hazır. URL: ${url}`);
    return client;
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
const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

function httpGet(url, extraHeaders = {}, maxRetry = 3) {
    return new Promise((resolve, reject) => {
        const RETRY_DELAYS = [2000, 5000, 10000];

        const attempt = (tryNum) => {
            const options = {
                headers: {
                    'User-Agent':      randUA(),
                    'Accept':          'text/html,application/json,*/*',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection':      'keep-alive',
                    ...extraHeaders,
                }
            };

            https.get(url, options, res => {
                if (res.statusCode === 429) {
                    const retryAfter = parseInt(res.headers['retry-after'] || '15', 10);
                    const delay = Math.max(retryAfter * 1000, RETRY_DELAYS[tryNum - 1] || 15000);
                    log(`  ⏳ 429 Rate-limit (${url.slice(0, 55)}...), ${delay}ms bekleniyor...`);
                    if (tryNum < maxRetry) { setTimeout(() => attempt(tryNum + 1), delay); return; }
                    reject(new Error(`429 rate-limit aşıldı: ${url}`)); return;
                }

                if (res.statusCode >= 500) {
                    const delay = RETRY_DELAYS[tryNum - 1] || 5000;
                    if (tryNum < maxRetry) {
                        log(`  🔁 HTTP ${res.statusCode} (${url.slice(0, 55)}...), ${delay}ms retry ${tryNum}/${maxRetry}...`);
                        setTimeout(() => attempt(tryNum + 1), delay);
                        return;
                    }
                    reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return;
                }

                const encoding = res.headers['content-encoding'] || '';
                const chunks   = [];

                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);

                    const decode = (err, decoded) => {
                        if (err) { resolve(buf.toString('utf8')); }
                        else     { resolve(decoded.toString('utf8')); }
                    };

                    if (encoding === 'gzip') {
                        zlib.gunzip(buf, decode);
                    } else if (encoding === 'deflate') {
                        zlib.inflate(buf, (err, result) => {
                            if (err) zlib.inflateRaw(buf, decode);
                            else decode(null, result);
                        });
                    } else if (encoding === 'br') {
                        zlib.brotliDecompress(buf, decode);
                    } else {
                        resolve(buf.toString('utf8'));
                    }
                });

                res.on('error', err => reject(err));
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

async function httpGetJSON(url, extraHeaders = {}) {
    const raw = await httpGet(url, extraHeaders);
    if (raw.trimStart().startsWith('<')) throw new Error(`HTML döndü: ${raw.slice(0, 80)}`);
    try { return JSON.parse(raw); }
    catch (e1) {
        try {
            const cleaned = raw
                .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
                .replace(/[\x00-\x1F\x7F]/g, ' ');
            return JSON.parse(cleaned);
        } catch (e2) {
            throw new Error(`JSON parse hatası: ${e2.message} | ham: ${raw.slice(0, 120)}`);
        }
    }
}

// ─── MACKOLİK ANA API ────────────────────────────────────────────────────────
async function fetchMackolik(dateStr) {
    const url = `https://vd.mackolik.com/livedata?date=${encodeURIComponent(dateStr)}`;
    return await httpGetJSON(url, { 'Referer': 'https://arsiv.mackolik.com/' });
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
    'Tehlikeli Ataklar':'Dangerous Attacks',
    'Ataklar':         'Attacks',
};

function parseStatsHtml(html, matchId) {
    if (!html || html.trim().length < 20) return [];
    const stats    = [];
    const parseVal = v => {
        v = (v || '').trim().replace(/%/g, '').replace(/&nbsp;/g, '').trim();
        if (v === '' || v === '-') return 0;
        if (v.includes('/')) return v;
        const n = parseFloat(v);
        return isNaN(n) ? v : n;
    };

    const p1 = /team-1-statistics-text"[^>]*>([\s\S]*?)<\/div>[\s\S]*?statistics-title-text"[^>]*>([\s\S]*?)<\/div>[\s\S]*?team-2-statistics-text"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = p1.exec(html)) !== null) {
        const homeRaw = m[1].replace(/<[^>]+>/g, '').trim();
        const titleTR = m[2].replace(/<[^>]+>/g, '').trim();
        const awayRaw = m[3].replace(/<[^>]+>/g, '').trim();
        const title   = STATS_NAME_MAP[titleTR] || titleTR;
        if (title && homeRaw !== '' && awayRaw !== '')
            stats.push({ type: title, homeVal: parseVal(homeRaw), awayVal: parseVal(awayRaw) });
    }
    if (stats.length > 0) return stats;

    const p2 = /<td[^>]+class="[^"]*team1[^"]*"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]+class="[^"]*statsName[^"]*"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]+class="[^"]*team2[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    while ((m = p2.exec(html)) !== null) {
        const homeRaw = m[1].replace(/<[^>]+>/g, '').trim();
        const titleTR = m[2].replace(/<[^>]+>/g, '').trim();
        const awayRaw = m[3].replace(/<[^>]+>/g, '').trim();
        const title   = STATS_NAME_MAP[titleTR] || titleTR;
        if (title && homeRaw !== '' && awayRaw !== '')
            stats.push({ type: title, homeVal: parseVal(homeRaw), awayVal: parseVal(awayRaw) });
    }
    if (stats.length > 0) return stats;

    const jsonMatch = html.match(/\{[\s\S]*?"stats"[\s\S]*?\}/);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            if (Array.isArray(obj.stats) && obj.stats.length > 0) {
                return obj.stats.map(s => ({
                    type:    STATS_NAME_MAP[s.name] || s.name || s.type || 'Unknown',
                    homeVal: parseVal(String(s.home ?? s.homeVal ?? 0)),
                    awayVal: parseVal(String(s.away ?? s.awayVal ?? 0)),
                })).filter(s => s.type && s.type !== 'Unknown');
            }
        } catch(_) {}
    }

    if (html.trim().length > 50) {
        log(`  ⚠️  Stats boş matchId=${matchId} | ham: ${html.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    return [];
}

async function fetchMatchStats(matchId) {
    if (SKIP_STATS) return [];
    const url = `https://arsiv.mackolik.com/AjaxHandlers/MatchHandler.aspx?command=optaStats&id=${matchId}`;
    try {
        const raw = await httpGet(url, { 'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/` });
        return parseStatsHtml(raw, matchId);
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
        const teamId    = parseInt(teamIdMatch[1], 10);
        const rankMatch = block.match(/<td[^>]*>\s*<b>(\d+)<\/b>\s*<\/td>/);
        if (!rankMatch) continue;
        const rank      = parseInt(rankMatch[1], 10);
        const nameMatch = block.match(/target="_blank"[^>]*>\s*([^<]+?)\s*<\/a>/);
        const name      = nameMatch ? nameMatch[1].trim() : '';
        const nums      = [...block.matchAll(/<td[^>]*align="right"[^>]*>(?:<b>)?(\d+)(?:<\/b>)?<\/td>/g)]
            .map(m => parseInt(m[1], 10));
        if (nums.length < 5) continue;
        const [played, win, draw, lose, points] = nums;
        standings.push({ rank, teamId, teamName: name, played, win, draw, lose, points });
    }
    return standings;
}

async function fetchMatchStandings(matchId) {
    if (SKIP_STANDINGS) return [];
    const url = `https://arsiv.mackolik.com/AjaxHandlers/StandingHandler.aspx?command=matchStanding&id=${matchId}&sv=1`;
    try {
        const raw    = await httpGet(url, { 'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/` });
        const result = parseStandingsHtml(raw);
        if (result.length === 0 && raw.trim().length > 100 && !raw.includes('502'))
            log(`  ⚠️  Standings boş matchId=${matchId} | ham: ${raw.slice(0, 120).replace(/\s+/g, ' ')}`);
        return result;
    } catch (e) {
        logErr(`  ❌ Standings matchId=${matchId}: ${e.message}`);
        return [];
    }
}

// ─── TEK MAÇ PARSE ────────────────────────────────────────────────────────────
function parseMatch(m, targetDate) {
    if (!Array.isArray(m) || m.length < 37) return null;

    const li          = Array.isArray(m[36]) ? m[36] : [];
    const sportTypeId = parseInt(li[11], 10) || 1;
    if (sportTypeId !== 1) return null;

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

    let homeGoals = toInt(m[12]);
    let awayGoals = toInt(m[13]);
    if (homeGoals === null || awayGoals === null) {
        const s = typeof m[7] === 'string' ? m[7].trim() : '';
        if (s.includes('-')) {
            const [h, a] = s.split('-');
            homeGoals = homeGoals ?? toInt(h);
            awayGoals = awayGoals ?? toInt(a);
        }
    }

    let htHome = null, htAway = null;
    const htStr = typeof m[7] === 'string' ? m[7].replace(/\s/g, '') : '';
    if (htStr.includes('-')) {
        const parts = htStr.split('-');
        htHome = toInt(parts[0]);
        htAway = toInt(parts[1]);
    }

    const homeShotsOT = typeof m[12] === 'number' ? m[12] : null;
    const awayShotsOT = typeof m[13] === 'number' ? m[13] : null;
    const rcHome      = typeof m[10] === 'number' ? m[10] : 0;
    const rcAway      = typeof m[11] === 'number' ? m[11] : 0;

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
        ? (homeGoals > awayGoals ? true  : homeGoals === awayGoals ? null : false) : null;
    const awayWin = homeGoals !== null && awayGoals !== null
        ? (awayGoals > homeGoals ? true  : homeGoals === awayGoals ? null : false) : null;

    const homeLogoUrl   = homeId    > 0 ? `https://im.mackolik.com/img/logo/buyuk/${homeId}.gif`  : null;
    const awayLogoUrl   = awayId    > 0 ? `https://im.mackolik.com/img/logo/buyuk/${awayId}.gif`  : null;

    const initialStats = homeShotsOT !== null ? [{
        type: 'Shots on Goal', homeVal: homeShotsOT, awayVal: awayShotsOT ?? 0,
    }] : [];

    return {
        fixture: {
            id: matchId, timezone: 'Europe/Istanbul', date: isoDate, timestamp,
            status,
        },
        league: {
            id: leagueId, name: leagueName, country: countryName,
            season: seasonYear, round: 'Regular Season', code: leagueCode,
        },
        teams: {
            home: { id: homeId, name: m[2] || 'Unknown', logo: homeLogoUrl, winner: homeWin, red_cards: rcHome },
            away: { id: awayId, name: m[4] || 'Unknown', logo: awayLogoUrl, winner: awayWin, red_cards: rcAway },
        },
        goals:     { home: homeGoals, away: awayGoals },
        score:     { halftime: { home: htHome, away: htAway }, fulltime: { home: homeGoals, away: awayGoals } },
        events:    [],
        h2h:       null,
        standings: [],
        stats:     initialStats,
        lineups:   { home: { startXI: [], substitutes: [] }, away: { startXI: [], substitutes: [] } },
    };
}

// ─── EVENT TYPE MAP ───────────────────────────────────────────────────────────
const EVENT_TYPE_MAP = {
    1:  { type: 'Goal',  detail: 'Normal Goal'     },
    12: { type: 'Goal',  detail: 'Penalty'         },
    13: { type: 'Goal',  detail: 'Own Goal'        },
    2:  { type: 'Card',  detail: 'Yellow Card'     },
    3:  { type: 'Card',  detail: 'Red Card'        },
    6:  { type: 'Card',  detail: 'Yellow Red Card' },
    4:  { type: 'subst', detail: 'Substitution'    },
    5:  { type: 'Var',   detail: 'VAR Decision'    },
};

// ─── EVENTS + LINEUPS + STATS + STANDINGS ENRİCH ─────────────────────────────
async function enrichMatchEvents(matches) {
    log(`\n🔍 Detaylar çekiliyor... ${matches.length} maç`);
    let fetchedH2H = 0, failedH2H = 0;

    const eligible = matches.filter(m => !['NS', 'PST', 'CANC'].includes(m.fixture.status.short));
    log(`  📌 Uygun maç: ${eligible.length} | Concurrency: ${CONCURRENCY}`);

    const parsePlayers = (arr, count) => {
        if (!Array.isArray(arr)) return { startXI: [], substitutes: [] };
        const players = arr.map(p => ({
            id:     Number(p[0]) || 0,
            name:   String(p[1] || ''),
            number: Number(p[2]) || 0,
        }));
        return { startXI: players.slice(0, count), substitutes: players.slice(count) };
    };

    let fetchedEvents = 0, emptyEvents = 0, failedDetails = 0;
    let fetchedStats  = 0, failedStats  = 0;
    let fetchedStand  = 0, failedStand  = 0;

    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
        const batch      = eligible.slice(i, i + CONCURRENCY);
        const batchNum   = Math.floor(i / CONCURRENCY) + 1;
        const totalBatch = Math.ceil(eligible.length / CONCURRENCY);

        log(`  📦 Batch ${batchNum}/${totalBatch} (${i + 1}-${Math.min(i + CONCURRENCY, eligible.length)})`);

        await Promise.all(batch.map(async (match) => {
            const matchId = match.fixture.id;

            // ── 1. DETAILS (events + lineups) ──────────────────────────────
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
                        const playerName = ev[3] || '';
                        const typeCode   = ev[4];
                        const extra      = ev[5] || {};
                        const teamSide   = teamCode === 1 ? 'home' : 'away';
                        const teamName   = teamCode === 1 ? match.teams.home.name : match.teams.away.name;
                        const mapped     = EVENT_TYPE_MAP[typeCode] || { type: 'Other', detail: '' };
                        return {
                            minute:      Number(minute) || 0,
                            minuteExtra: extra.extraMin ? Number(extra.extraMin) : null,
                            type:        mapped.type,
                            detail:      mapped.detail,
                            playerName:  String(playerName),
                            assistName:  extra.astName ? String(extra.astName) : null,
                            teamSide,
                            teamId:      teamCode === 1 ? match.teams.home.id : match.teams.away.id,
                            teamName,
                        };
                    });
                } else {
                    emptyEvents++;
                }
            }

            // ── 2. STATS ────────────────────────────────────────────────────
            await sleep(EXTRA_DELAY + Math.floor(Math.random() * 400));
            const statsResult = await fetchMatchStats(matchId);
            if (statsResult.length > 0) {
                match.stats = statsResult;
                fetchedStats++;
            } else {
                failedStats++;
            }

            // ── 3. STANDINGS ────────────────────────────────────────────────
            await sleep(EXTRA_DELAY + Math.floor(Math.random() * 600));
            const standResult = await fetchMatchStandings(matchId);
            if (standResult.length > 0) {
                match.standings = standResult;
                fetchedStand++;
            } else {
                failedStand++;
            }

            // ── 4. H2H ──────────────────────────────────────────────────────
            await sleep(EXTRA_DELAY + Math.floor(Math.random() * 400));
            const h2hResult = await fetchMatchH2H(matchId);
            if (h2hResult) {
                match.h2h = h2hResult;
                fetchedH2H++;
            } else {
                failedH2H++;
            }
        }));

        if (i + CONCURRENCY < eligible.length) await randWait();
    }

    log(`  ✅ Events  → dolu: ${fetchedEvents} | boş: ${emptyEvents} | hata: ${failedDetails}`);
    log(`  ✅ Stats   → dolu: ${fetchedStats} | boş/hata: ${failedStats}`);
    log(`  ✅ Stands  → dolu: ${fetchedStand} | boş/hata: ${failedStand}`);
    log(`  ✅ H2H     → dolu: ${fetchedH2H} | boş/hata: ${failedH2H}`);
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

    log(`  ✅ Parse: ${all.length} futbol | Bitmemiş atlandı: ${skipped} | Kaydedilecek: ${matches.length}`);
    return matches;
}

// ─── H2H ─────────────────────────────────────────────────────────────────────
async function fetchMatchH2H(matchId) {
    const url = `https://arsiv.mackolik.com/Match/Head2Head.aspx?id=${matchId}&s=1`;
    try {
        const raw = await httpGet(url, { 'Referer': `https://arsiv.mackolik.com/Mac/${matchId}/` });
        if (raw.includes('Object moved') || raw.includes('PageError.htm')) {
            log(`  ⚠️ H2H sayfası bulunamadı. matchId=${matchId}`);
            return { h2h: [], homeForm: [], awayForm: [], homeScorers: [], awayScorers: [] };
        }
        const result = parseH2HHtml(raw);
        log(`  🔍 H2H parse: h2h=${result.h2h.length} form=${result.homeForm.length}/${result.awayForm.length}`);
        return result;
    } catch (e) {
        logErr(`  ❌ H2H matchId=${matchId}: ${e.message}`);
        return null;
    }
}

function parseH2HHtml(html) {
    const result = { h2h: [], homeForm: [], awayForm: [], homeScorers: [], awayScorers: [] };
    if (!html || typeof html !== 'string') return result;

    const h2hRe = /Aralarındaki Maçlar\s*<\/div>[\s\S]*?<table[^>]*class="md-table3"[^>]*>([\s\S]*?)<\/table>/;
    const h2hMatch = html.match(h2hRe);
    if (h2hMatch) {
        const rowRe = /<tr class="row alt[12]">([\s\S]*?)<\/tr>/g;
        let row;
        while ((row = rowRe.exec(h2hMatch[1])) !== null) {
            const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(t => t[1]);
            if (tds.length >= 8) {
                const dateRaw = tds[2].replace(/<[^>]+>/g, '').trim();
                const scoreM  = tds[6].match(/\/Mac\/(\d+)\/[^>]+><b>\s*(\d+)\s*-\s*(\d+)/);
                if (!scoreM) continue;
                const matchId_  = parseInt(scoreM[1], 10);
                const homeGoals = parseInt(scoreM[2], 10);
                const awayGoals = parseInt(scoreM[3], 10);
                const homeName  = tds[5].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
                const awayName  = tds[7].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
                const htM       = tds[8].match(/(\d+)\s*-\s*(\d+)/);
                const htHome    = htM ? parseInt(htM[1], 10) : null;
                const htAway    = htM ? parseInt(htM[2], 10) : null;
                const homeWinner = homeGoals > awayGoals ? true : (homeGoals < awayGoals ? false : null);
                result.h2h.push({ matchId: matchId_, date: dateRaw, homeTeam: homeName, awayTeam: awayName, homeGoals, awayGoals, htHome, htAway, homeWinner });
                if (result.h2h.length >= 5) break;
            }
        }
    }

    const formTables = [];
    const formRe = /Form Durumu\s*<\/div>\s*<table[^>]*>([\s\S]*?)<\/table>/g;
    let mForm;
    while ((mForm = formRe.exec(html)) !== null) formTables.push(mForm[1]);

    const parseFormTable = (tableHtml) => {
        const rows  = [];
        const rowRe = /<tr[^>]*class="row alt[12]"[^>]*>([\s\S]*?)<\/tr>/g;
        let m;
        while ((m = rowRe.exec(tableHtml)) !== null) {
            const parts = m[1].split(/<td[^>]*>/i);
            if (parts.length < 7) continue;
            let dateStr = parts[2].replace(/<[^>]+>/g, '').trim();
            const dMatch = dateStr.match(/\d{2}\.\d{2}/);
            dateStr = dMatch ? dMatch[0] : '';
            const homeTeam = parts[3].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
            const scoreM   = parts[4].match(/<b>\s*(\d+)\s*-\s*(\d+)/);
            if (!scoreM) continue;
            const awayTeam  = parts[5].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
            const imgM      = parts[6].match(/img5\/(G|B|M)\.png/);
            const resultVal = imgM ? (imgM[1] === 'G' ? 'W' : imgM[1] === 'B' ? 'D' : 'L') : '';
            rows.push({ date: dateStr, homeTeam, awayTeam, homeGoals: parseInt(scoreM[1], 10), awayGoals: parseInt(scoreM[2], 10), result: resultVal });
            if (rows.length >= 10) break;
        }
        return rows;
    };

    if (formTables.length > 0) result.homeForm = parseFormTable(formTables[0]);
    if (formTables.length > 1) result.awayForm = parseFormTable(formTables[1]);

    const scorerTables = [];
    const scorerRe = /En Golc[üu]ler\s*<\/div>\s*<table[^>]*>([\s\S]*?)<\/table>/g;
    let mScorer;
    while ((mScorer = scorerRe.exec(html)) !== null) scorerTables.push(mScorer[1]);

    const parseScorerTable = (tableHtml) => {
        const scorers = [];
        const rowRe   = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
        let m;
        while ((m = rowRe.exec(tableHtml)) !== null) {
            const b     = m[1];
            const nameM  = b.match(/href="[^"]*\/Futbolcu\/\d+\/[^"]*">\s*([^<]+?)\s*<\/a>/);
            const goalsM = b.match(/<b>(\d+)<\/b>/);
            if (nameM && goalsM) {
                scorers.push({ name: nameM[1].trim(), goals: parseInt(goalsM[1], 10) });
                if (scorers.length >= 3) break;
            }
        }
        return scorers;
    };

    if (scorerTables.length > 0) result.homeScorers = parseScorerTable(scorerTables[0]);
    if (scorerTables.length > 1) result.awayScorers = parseScorerTable(scorerTables[1]);

    return result;
}

// ─── SUPABASE YARDIMCI: güvenli upsert (1000 satır limit) ────────────────────
async function supabaseUpsert(client, table, rows, conflictCol = null) {
    if (!rows || rows.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        let q = client.from(table).upsert(chunk, { ignoreDuplicates: false });
        if (conflictCol) q = client.from(table).upsert(chunk, { onConflict: conflictCol, ignoreDuplicates: false });
        const { error } = await q;
        if (error) logErr(`  ❌ Supabase upsert hatası [${table}]: ${error.message}`);
    }
}

async function supabaseDelete(client, table, matchId) {
    const { error } = await client.from(table).delete().eq('match_id', matchId);
    if (error) logErr(`  ❌ Supabase delete hatası [${table}] matchId=${matchId}: ${error.message}`);
}

// ─── SUPABASE KAYDET ──────────────────────────────────────────────────────────
async function saveToSupabase(client, dateStr, matches) {
    log(`\n💾 Supabase'e yazılıyor... ${matches.length} maç | ${dateStr}`);

    // ── 1. arsiv_matches (ana özet) ──────────────────────────────────────────
    const matchRows = matches.map(m => ({
        match_id:       m.fixture.id,
        date:           dateStr,
        timestamp:      m.fixture.timestamp,
        status_short:   m.fixture.status.short,
        status_long:    m.fixture.status.long,
        home_team_id:   m.teams.home.id,
        home_team_name: m.teams.home.name,
        home_team_logo: m.teams.home.logo,
        away_team_id:   m.teams.away.id,
        away_team_name: m.teams.away.name,
        away_team_logo: m.teams.away.logo,
        home_goals:     m.goals.home,
        away_goals:     m.goals.away,
        ht_home:        m.score.halftime.home,
        ht_away:        m.score.halftime.away,
        league_id:      m.league.id,
        league_name:    m.league.name,
        league_country: m.league.country,
        league_season:  m.league.season,
        league_code:    m.league.code,
    }));
    await supabaseUpsert(client, 'arsiv_matches', matchRows, 'match_id');
    log(`  ✅ arsiv_matches: ${matchRows.length} satır`);

    // ── 2. arsiv_events ───────────────────────────────────────────────────────
    // Önce o maçların eski event'larını sil (idempotent re-run için)
    const matchIds = matches.map(m => m.fixture.id);
    for (const mid of matchIds) await supabaseDelete(client, 'arsiv_events', mid);

    const eventRows = [];
    for (const m of matches) {
        for (const ev of (m.events || [])) {
            eventRows.push({
                match_id:     m.fixture.id,
                minute:       ev.minute,
                minute_extra: ev.minuteExtra ?? null,
                type:         ev.type,
                detail:       ev.detail,
                player_name:  ev.playerName || null,
                assist_name:  ev.assistName || null,
                team_side:    ev.teamSide,
                team_id:      ev.teamId,
                team_name:    ev.teamName,
            });
        }
    }
    await supabaseUpsert(client, 'arsiv_events', eventRows);
    log(`  ✅ arsiv_events: ${eventRows.length} satır`);

    // ── 3. arsiv_stats ────────────────────────────────────────────────────────
    for (const mid of matchIds) await supabaseDelete(client, 'arsiv_stats', mid);

    const statRows = [];
    for (const m of matches) {
        for (const s of (m.stats || [])) {
            statRows.push({
                match_id: m.fixture.id,
                type:     s.type,
                home_val: String(s.homeVal ?? ''),
                away_val: String(s.awayVal ?? ''),
            });
        }
    }
    await supabaseUpsert(client, 'arsiv_stats', statRows);
    log(`  ✅ arsiv_stats: ${statRows.length} satır`);

    // ── 4. arsiv_standings ────────────────────────────────────────────────────
    for (const mid of matchIds) await supabaseDelete(client, 'arsiv_standings', mid);

    const standRows = [];
    for (const m of matches) {
        for (const s of (m.standings || [])) {
            standRows.push({
                match_id:  m.fixture.id,
                rank:      s.rank,
                team_id:   s.teamId,
                team_name: s.teamName,
                played:    s.played,
                win:       s.win,
                draw:      s.draw,
                lose:      s.lose,
                points:    s.points,
            });
        }
    }
    await supabaseUpsert(client, 'arsiv_standings', standRows);
    log(`  ✅ arsiv_standings: ${standRows.length} satır`);

    // ── 5. arsiv_lineups ──────────────────────────────────────────────────────
    for (const mid of matchIds) await supabaseDelete(client, 'arsiv_lineups', mid);

    const lineupRows = [];
    for (const m of matches) {
        for (const side of ['home', 'away']) {
            const lineup = m.lineups?.[side];
            if (!lineup) continue;
            for (const p of (lineup.startXI || [])) {
                lineupRows.push({ match_id: m.fixture.id, team_side: side, player_id: p.id, player_name: p.name, player_number: p.number, is_starter: true });
            }
            for (const p of (lineup.substitutes || [])) {
                lineupRows.push({ match_id: m.fixture.id, team_side: side, player_id: p.id, player_name: p.name, player_number: p.number, is_starter: false });
            }
        }
    }
    await supabaseUpsert(client, 'arsiv_lineups', lineupRows);
    log(`  ✅ arsiv_lineups: ${lineupRows.length} satır`);

    // ── 6. arsiv_h2h ─────────────────────────────────────────────────────────
    for (const mid of matchIds) await supabaseDelete(client, 'arsiv_h2h', mid);

    const h2hRows = [];
    for (const m of matches) {
        if (!m.h2h) continue;
        const mid = m.fixture.id;

        for (const r of (m.h2h.h2h || [])) {
            h2hRows.push({ match_id: mid, record_type: 'h2h', h2h_match_id: r.matchId ?? null, date: r.date, home_team: r.homeTeam, away_team: r.awayTeam, home_goals: r.homeGoals, away_goals: r.awayGoals, ht_home: r.htHome ?? null, ht_away: r.htAway ?? null, home_winner: r.homeWinner ?? null, result: null });
        }
        for (const r of (m.h2h.homeForm || [])) {
            h2hRows.push({ match_id: mid, record_type: 'home_form', h2h_match_id: null, date: r.date, home_team: r.homeTeam, away_team: r.awayTeam, home_goals: r.homeGoals, away_goals: r.awayGoals, ht_home: null, ht_away: null, home_winner: null, result: r.result });
        }
        for (const r of (m.h2h.awayForm || [])) {
            h2hRows.push({ match_id: mid, record_type: 'away_form', h2h_match_id: null, date: r.date, home_team: r.homeTeam, away_team: r.awayTeam, home_goals: r.homeGoals, away_goals: r.awayGoals, ht_home: null, ht_away: null, home_winner: null, result: r.result });
        }
    }
    await supabaseUpsert(client, 'arsiv_h2h', h2hRows);
    log(`  ✅ arsiv_h2h: ${h2hRows.length} satır`);

    // ── 7. arsiv_scorers ──────────────────────────────────────────────────────
    for (const mid of matchIds) await supabaseDelete(client, 'arsiv_scorers', mid);

    const scorerRows = [];
    for (const m of matches) {
        if (!m.h2h) continue;
        for (const s of (m.h2h.homeScorers || [])) {
            scorerRows.push({ match_id: m.fixture.id, team_side: 'home', name: s.name, goals: s.goals });
        }
        for (const s of (m.h2h.awayScorers || [])) {
            scorerRows.push({ match_id: m.fixture.id, team_side: 'away', name: s.name, goals: s.goals });
        }
    }
    await supabaseUpsert(client, 'arsiv_scorers', scorerRows);
    log(`  ✅ arsiv_scorers: ${scorerRows.length} satır`);

    // ── Özet ─────────────────────────────────────────────────────────────────
    const withScore     = matches.filter(m => m.goals.home !== null).length;
    const withEvents    = matches.filter(m => m.events?.length    > 0).length;
    const withLineups   = matches.filter(m => m.lineups?.home?.startXI?.length > 0).length;
    const withStats     = matches.filter(m => m.stats?.length     > 0).length;
    const withStandings = matches.filter(m => m.standings?.length > 0).length;
    const totalEvents   = matches.reduce((s, m) => s + (m.events?.length || 0), 0);
    const withH2H       = matches.filter(m => m.h2h?.h2h?.length  > 0).length;
    const leagues       = [...new Set(matches.map(m => `${m.league.country}: ${m.league.name}`))];

    log(`\n  ✅ ${matches.length} maç → Supabase | ${dateStr}`);
    log(`  📋 ${leagues.length} lig: ${leagues.slice(0, 6).join(' | ')}${leagues.length > 6 ? ` +${leagues.length - 6}` : ''}`);
    log(`  ⚽ Skoru olan:   ${withScore}/${matches.length}`);
    log(`  🎯 Events:       ${withEvents}/${matches.length} (toplam ${totalEvents})`);
    log(`  👕 Lineup:       ${withLineups}/${matches.length}`);
    log(`  📊 Stats:        ${withStats}/${matches.length}`);
    log(`  🏆 Standings:    ${withStandings}/${matches.length}`);
    log(`  🔄 H2H:          ${withH2H}/${matches.length}`);
}

// ─── TEK GÜN İŞLE ────────────────────────────────────────────────────────────
async function processDate(client, targetDate) {
    const dateStr = formatDate(targetDate);
    log(`\n📆 İşleniyor: ${dateStr}`);
    try {
        let matches = await collectMatches(targetDate);
        if (matches.length > 0) {
            matches = await enrichMatchEvents(matches);
            await saveToSupabase(client, dateStr, matches);
        } else {
            log(`  ❌ Kayıt yok: ${dateStr}`);
        }
    } catch (e) {
        logErr(`  ⚠️  ${dateStr} atlandı: ${e.message}`);
    }
}

// ─── ANA AKIŞ ────────────────────────────────────────────────────────────────
(async () => {
    let client;
    try { client = initSupabase(); }
    catch (e) { logErr('💥 Supabase:', e.message); logFile.end(() => process.exit(1)); return; }

    try {
        if (MODE === 'daily') {
            const y = getYesterday();
            log(`📅 TR dün: ${formatDate(y)}`);
            await processDate(client, y);

        } else if (MODE === 'single') {
            if (!SINGLE) throw new Error('--date gerekli! (YYYY-MM-DD)');
            await processDate(client, parseTargetDate(SINGLE));

        } else if (MODE === 'backfill') {
            if (!FROM_DATE || !TO_DATE) throw new Error('--from ve --to gerekli! (YYYY-MM-DD)');
            let start = parseTargetDate(FROM_DATE);
            let end   = parseTargetDate(TO_DATE);
            if (start > end) { log('⚠️  from > to, düzeltildi'); [start, end] = [end, start]; }
            const total = Math.round((end - start) / 86400000) + 1;
            log(`🗓️  ${formatDate(start)} → ${formatDate(end)} (${total} gün)`);
            for (let i = 0; i < total; i++) {
                const d = new Date(start);
                d.setUTCDate(start.getUTCDate() + i);
                await processDate(client, d);
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
