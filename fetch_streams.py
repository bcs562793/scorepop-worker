"""
fetch_streams.py — Canlı stream'li maçları bulur, EC2'ye gönderir, Supabase'e yazar.
Mac veya GitHub Actions'ta çalışır (token buradan gelir).

Ortam değişkenleri:
  BILYONER_ACCESS_TOKEN
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  EC2_API_URL      (varsayılan: http://13.48.55.242:5000)
  EC2_API_SECRET   (varsayılan: bilyoner123)
"""

import os, json, uuid, time
import urllib.request, urllib.error, ssl
from datetime import datetime, timezone

# ── Sabitler ──────────────────────────────────────────────────────
BASE         = "https://www.bilyoner.com/api/mobile"
PLATFORM     = "40CAB7292CD83F7EE0631FC35A0AFC75"
DEVICE_ID    = "6949B800-5EB1-4661-9E28-B54A11AA99AA"
TOKEN        = os.environ["BILYONER_ACCESS_TOKEN"]
SUPA_URL     = os.environ.get("SUPABASE_URL", "")
SUPA_KEY     = os.environ.get("SUPABASE_SERVICE_KEY", "")
EC2_API      = os.environ.get("EC2_API_URL", "http://13.48.55.242:5000")
EC2_SECRET   = os.environ.get("EC2_API_SECRET", "bilyoner123")
SPORTS       = ["soccer", "basketball"]
ctx          = ssl.create_default_context()

# Client IP (token'ın üretildiği IP)
def _ip():
    try:
        return urllib.request.urlopen(
            "https://api.ipify.org", context=ctx, timeout=5
        ).read().decode().strip()
    except:
        return ""

CLIENT_IP = _ip()
print(f"🌐 IP: {CLIENT_IP}")

HDRS = {
    "X-Auth-Token":             TOKEN,
    "PLATFORM-TOKEN":           PLATFORM,
    "X-DEVICE-ID":              DEVICE_ID,
    "X-CLIENT-CHANNEL":         "WEB",
    "X-CLIENT-APP-VERSION":     "3.99.1",
    "X-CLIENT-BROWSER-VERSION": "Chrome / v148.0.0.0",
    "Accept":                   "application/json",
    "clientIp":                 CLIENT_IP,
}
PERFORM_HDRS = {
    "Referer":     "https://www.bilyoner.com/",
    "pf-hostpage": "https://www.bilyoner.com",
    "Accept":      "application/json",
}


def get(url, hdrs=HDRS):
    req = urllib.request.Request(url, headers=hdrs)
    return json.loads(urllib.request.urlopen(req, context=ctx, timeout=15).read())


# ── 1. Canlı maç listesi ──────────────────────────────────────────
def fetch_live():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000")
    result = []
    for sport in SPORTS:
        try:
            data = get(f"{BASE}/live-score/event/v2/{sport}?date={today}")
        except Exception as e:
            print(f"  [{sport}] hata: {e}")
            continue
        for comp in data.get("competitions", []):
            for evt in comp.get("events", []):
                if evt.get("streamType", "NONE") == "NONE": continue
                if not evt.get("isLive", 0): continue
                ms     = evt.get("matchStatus", {})
                status = ms.get("type","") if isinstance(ms,dict) else str(ms)
                result.append({
                    "sbsEventId":  evt["sbsEventId"],
                    "homeTeam":    evt.get("homeTeam",""),
                    "awayTeam":    evt.get("awayTeam",""),
                    "competition": comp.get("title",""),
                    "sport":       sport,
                    "status":      status,
                })
    return result


# ── 2. HLS URL al ─────────────────────────────────────────────────
def get_hls(sbs_id):
    ext = str(uuid.uuid4())

    # Perform
    try:
        d = get(f"{BASE}/live-stream/perform/authentication/{sbs_id}/v3?externalCustomerId={ext}")
        r = d.get("authenticationResult", {})
        if r.get("webStreamStatus") == "STARTED" and r.get("authenticationUrl"):
            perf = get(r["authenticationUrl"], PERFORM_HDRS)
            ls   = perf["launchInfo"]["streamLauncher"]
            best = next((s for s in ls if "med" in s["playerAlias"]), ls[0])
            return best["launcherURL"], "PERFORM"
    except urllib.error.HTTPError as e:
        if e.code != 401:
            print(f"    Perform {sbs_id}: HTTP {e.code}")
    except Exception as e:
        print(f"    Perform {sbs_id}: {e}")

    # IMG Arena
    try:
        hdr = get(f"{BASE}/match-card/{sbs_id}/header/v8")
        si  = hdr.get("streamInfo", {})
        if not isinstance(si, dict) or si.get("provider") != "IMG": return None, ""
        img_id = si.get("liveStreamId") or si.get("webStreamId")
        if not img_id or si.get("liveStreamStatus") != "STARTED": return None, ""
        d2 = get(f"{BASE}/live-stream/img/{img_id}/authentication")
        r2 = d2.get("authenticationResult", {})
        if not r2.get("authenticationUrl"): return None, ""
        resp = get(r2["authenticationUrl"], {"Accept": "application/json"})
        return resp.get("hlsUrl"), "IMG"
    except Exception as e:
        print(f"    IMG {sbs_id}: {e}")

    return None, ""


# ── 3. EC2'ye gönder ──────────────────────────────────────────────
def send_ec2(sbs_id, hls_url, home, away):
    payload = json.dumps({
        "sbsEventId": sbs_id,
        "hlsUrl":     hls_url,
        "homeTeam":   home,
        "awayTeam":   away,
    }).encode()
    req = urllib.request.Request(
        f"{EC2_API}/start", data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Secret": EC2_SECRET}
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, context=ctx, timeout=20).read())
        return resp.get("relay")
    except Exception as e:
        print(f"    EC2 {sbs_id}: {e}")
        return None


# ── 4. Supabase'e yaz ─────────────────────────────────────────────
def supabase_upsert(rows):
    if not SUPA_URL or not SUPA_KEY or not rows: return
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/live_stream_urls",
        data=json.dumps(rows).encode(), method="POST",
        headers={
            "apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        }
    )
    try:
        urllib.request.urlopen(req, context=ctx, timeout=10)
        print(f"  💾 {len(rows)} satır Supabase'e yazıldı")
    except Exception as e:
        print(f"  Supabase: {e}")


# ── Ana akış ──────────────────────────────────────────────────────
def main():
    print("\n📺 Canlı stream'li maçlar taranıyor...")
    matches = fetch_live()
    print(f"  Toplam: {len(matches)} maç")

    rows  = []
    found = 0

    for m in matches:
        sid  = m["sbsEventId"]
        home = m["homeTeam"]
        away = m["awayTeam"]

        hls_url, provider = get_hls(sid)
        if not hls_url:
            continue

        found += 1
        print(f"  ✅ [{provider}] {home} vs {away}")

        relay = send_ec2(sid, hls_url, home, away)
        if not relay:
            relay = None

        rows.append({
            "sbs_event_id":    sid,
            "relay_url":       relay,
            "stream_provider": provider,
            "home_team":       home,
            "away_team":       away,
            "competition_name":m["competition"],
            "match_status":    m["status"],
            "sport":           m["sport"],
            "stream_fetched_at": datetime.now(timezone.utc).isoformat(),
        })

        time.sleep(0.3)

    print(f"\n✅ {found} stream bulundu")
    supabase_upsert(rows)


if __name__ == "__main__":
    main()
