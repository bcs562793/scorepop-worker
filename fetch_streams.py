"""
fetch_streams.py — Canlı maçların yayın URL'lerini Bilyoner'den çekip
                   Supabase'e kaydeder.

GitHub Actions'ta 10 dakikada bir çalışır.
Ortam değişkenleri:
  BILYONER_ACCESS_TOKEN  — Bilyoner X-Auth-Token
  SUPABASE_URL           — Supabase proje URL'si
  SUPABASE_SERVICE_KEY   — Supabase service_role key (RLS bypass için)
"""

import os, json, time, uuid
import urllib.request, urllib.error, ssl

# ─── Sabitler ─────────────────────────────────────────────────────
BILYONER_BASE    = "https://www.bilyoner.com/api/mobile"
PLATFORM_TOKEN   = "40CAB7292CD83F7EE0631FC35A0AFC75"
DEVICE_ID        = os.environ.get("BILYONER_DEVICE_ID",
                                  "6949B800-5EB1-4661-9E28-B54A11AA99AA")
APP_VERSION      = "3.99.1"
ACCESS_TOKEN     = os.environ.get("BILYONER_ACCESS_TOKEN", "")
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY     = os.environ.get("SUPABASE_SERVICE_KEY", "")

ctx = ssl.create_default_context()

def _my_ip() -> str:
    try:
        import urllib.request as _r
        return _r.urlopen("https://api.ipify.org", context=ctx, timeout=5).read().decode().strip()
    except:
        return ""

_CLIENT_IP = _my_ip()

BILYONER_HEADERS = {
    "X-Auth-Token":             ACCESS_TOKEN,
    "PLATFORM-TOKEN":           PLATFORM_TOKEN,
    "X-DEVICE-ID":              DEVICE_ID,
    "X-CLIENT-CHANNEL":         "WEB",
    "X-CLIENT-APP-VERSION":     APP_VERSION,
    "X-CLIENT-BROWSER-VERSION": "Chrome / v148.0.0.0",
    "Accept":                   "application/json",
    **({"clientIp": _CLIENT_IP} if _CLIENT_IP else {}),
}


def get(url: str, extra_headers: dict = {}) -> dict:
    req = urllib.request.Request(url, headers={**BILYONER_HEADERS, **extra_headers})
    try:
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        return json.loads(resp.read())
    except Exception as e:
        print(f"  ⚠️  GET {url[:80]}: {e}")
        return {}


def supabase_upsert(table: str, rows: list[dict]):
    """Supabase REST API ile upsert."""
    if not SUPABASE_URL or not SUPABASE_KEY or not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    data = json.dumps(rows).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates",
        }
    )
    try:
        urllib.request.urlopen(req, context=ctx, timeout=10)
    except Exception as e:
        print(f"  ⚠️  Supabase upsert {table}: {e}")


# ─── ADIM 1: Bugünkü canlı maçları çek ───────────────────────────
def fetch_live_matches(sport: str = "basketball") -> list[dict]:
    """
    /live-score/event/v2/{sport}?date=today
    streamType != 'NONE' olanları filtrele
    """
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000")
    data = get(f"{BILYONER_BASE}/live-score/event/v2/{sport}?date={today}")

    streamable = []
    for comp in data.get("competitions", []):
        for evt in comp.get("events", []):
            sbs_id     = evt.get("sbsEventId")
            stream_type = evt.get("streamType", "NONE")
            status      = evt.get("matchStatus", {}).get("type", "")

            # Canlı maçlar: status veya isLive bayrağı
            is_live = (
                status in ("LIVE", "INPLAY", "HALFTIME", "Q1", "Q2", "Q3", "Q4", "HT", "Playing", "1H", "2H", "ET")
                or str(evt.get("isLive", 0)) == "1"
            )
            if not is_live:
                continue
            if stream_type == "NONE" or not sbs_id:
                continue

            streamable.append({
                "sbsEventId":   sbs_id,
                "homeTeam":     evt.get("homeTeam"),
                "awayTeam":     evt.get("awayTeam"),
                "matchStatus":  status,
                "streamType":   stream_type,
                "competitionName": comp.get("title"),
            })
            print(f"  📺 {evt.get('homeTeam')} vs {evt.get('awayTeam')} "
                  f"[{stream_type}] — status={status} isLive={evt.get('isLive',0)}")

    return streamable


# ─── ADIM 2: Bilyoner auth URL'sini al ───────────────────────────
def fetch_auth_url(sbs_id: int) -> dict | None:
    """
    GET /api/mobile/live-stream/perform/authentication/{sbsEventId}/v3
         ?externalCustomerId={uuid}
    → authenticationUrl (IP bağımsız, Perform endpoint'i)
    → performAuthenticationToken
    """
    ext_id = str(uuid.uuid4())
    url = (f"{BILYONER_BASE}/live-stream/perform/authentication"
           f"/{sbs_id}/v3?externalCustomerId={ext_id}")
    data = get(url)

    result = data.get("authenticationResult", {})
    auth_url = result.get("authenticationUrl")
    if not auth_url:
        print(f"    ❌ {sbs_id}: authenticationUrl yok")
        return None

    print(f"    ✅ Auth URL alındı: {auth_url[:60]}...")
    return {
        "authUrl":  auth_url,
        "perfToken": result.get("performAuthenticationToken", ""),
    }


# ─── ADIM 3: Supabase'e kaydet ────────────────────────────────────
PERFORM_HDRS = {
    "Referer":     "https://www.bilyoner.com/",
    "pf-hostpage": "https://www.bilyoner.com",
    "Accept":      "application/json",
}

def extract_hdntl_url(hls_url: str) -> str | None:
    """
    IP-kilitli hdnea URL'den m3u8'i çek,
    içindeki IP-kilitsiz hdntl URL'yi döndür.
    """
    try:
        req  = urllib.request.Request(hls_url)
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        m3u8 = resp.read().decode("utf-8", errors="replace")

        # Base URL (hdntl path'lerin önüne gelecek)
        from urllib.parse import urlparse
        p    = urlparse(hls_url)
        base = f"{p.scheme}://{p.netloc}{'/'.join(p.path.split('/')[:-1])}/"

        # m3u8'deki hdntl satırını bul
        for line in m3u8.splitlines():
            line = line.strip()
            if line.startswith("hdntl=") and "playlist" in line:
                full = base + line
                print(f"    ✅ hdntl URL (IP-kilitsiz, 24h): {full[:80]}...")
                return full
    except Exception as e:
        print(f"    ⚠️  m3u8 parse hatası: {e}")
    return None


def get_universal_stream_url(auth_result: dict) -> str | None:
    """
    Sağlayıcıya göre hdntl tabanlı evrensel HLS URL al.
    """
    provider = auth_result.get("provider", "PERFORM")
    auth_url = auth_result.get("authUrl", "")

    if provider == "PERFORM":
        # Perform: authUrl → Perform launch → hdnea HLS → hdntl parse
        try:
            perf = get(auth_url, PERFORM_HDRS)
            launchers = perf["launchInfo"]["streamLauncher"]
            best = next((s for s in launchers if "med" in s["playerAlias"]), launchers[0])
            hls_url = best["launcherURL"]
            return extract_hdntl_url(hls_url)
        except Exception as e:
            print(f"    ⚠️  Perform HLS hatası: {e}")
            return None

    elif provider == "IMG":
        # IMG Arena: authUrl → IMG launch → hdnea HLS → hdntl parse
        try:
            img = get(auth_url, {"Accept": "application/json"})
            hls_url = img.get("hlsUrl", "")
            return extract_hdntl_url(hls_url)
        except Exception as e:
            print(f"    ⚠️  IMG HLS hatası: {e}")
            return None

    return None


EC2_API     = os.environ.get("EC2_API_URL", "http://13.48.55.242:5000")
EC2_SECRET  = os.environ.get("EC2_API_SECRET", "bilyoner123")

def send_to_ec2(match: dict) -> str | None:
    """HLS URL'yi EC2 API'ye gönder, relay URL'yi al."""
    payload = json.dumps({
        "sbsEventId": match["sbsEventId"],
        "hlsUrl":     match["authUrl"],
        "homeTeam":   match.get("homeTeam",""),
        "awayTeam":   match.get("awayTeam",""),
    }).encode()
    req = urllib.request.Request(
        f"{EC2_API}/start",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Secret":     EC2_SECRET,
        }
    )
    try:
        resp = urllib.request.urlopen(req, context=ctx, timeout=20)
        data = json.loads(resp.read())
        relay = data.get("relay")
        print(f"    ✅ EC2 relay: {relay}")
        return relay
    except Exception as e:
        print(f"    ❌ EC2 API hatası: {e}")
        return None


def save_to_supabase(matches_with_auth: list[dict]):
    """
    live_bball tablosuna stream_auth_url ve stream_type ekle.
    nesine_bid yerine sbs_event_id ile eşleştir.

    Tablo sütunları eklenmeli (migration):
      ALTER TABLE live_bball ADD COLUMN IF NOT EXISTS stream_auth_url TEXT;
      ALTER TABLE live_bball ADD COLUMN IF NOT EXISTS stream_type TEXT;
      ALTER TABLE live_bball ADD COLUMN IF NOT EXISTS stream_fetched_at TIMESTAMPTZ;
    """
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    rows = []
    for m in matches_with_auth:
        print(f"  🎬 {m['homeTeam']} vs {m['awayTeam']} için hdntl URL çekiliyor...")
        hdntl_url = get_universal_stream_url(m)
        if not hdntl_url:
            print(f"    ⚠️  hdntl URL alınamadı, atlanıyor")
            continue
        rows.append({
            "sbs_event_id":    m["sbsEventId"],
            "stream_url":      hdntl_url,        # IP-kilitsiz hdntl URL
            "stream_provider": m.get("provider", "PERFORM"),
            "stream_img_id":   m.get("imgId"),
            "home_team":       m.get("homeTeam"),
            "away_team":       m.get("awayTeam"),
            "competition_name":m.get("competitionName"),
            "match_status":    m.get("matchStatus"),
            "stream_fetched_at": now,
        })

    # live_stream_urls tablosuna yaz (daha temiz ayrım)
    supabase_upsert("live_stream_urls", rows)
    print(f"  💾 {len(rows)} stream URL Supabase'e kaydedildi")


# ─── ANA AKIŞ ─────────────────────────────────────────────────────
def main():
    if not ACCESS_TOKEN:
        print("❌ BILYONER_ACCESS_TOKEN eksik")
        return

    print("\n📺 Canlı yayın URL'leri çekiliyor...")

    # Basketbol ve futbol için paralel çek
    all_matches = []
    for sport in ["basketball", "soccer"]:
        print(f"\n[{sport.upper()}]")
        matches = fetch_live_matches(sport)
        all_matches.extend(matches)
        if not matches:
            print("  Yayınlanabilir maç yok")

    if not all_matches:
        print("\n✅ Şu an canlı yayınlanacak maç yok")
        print("   (FIXTURE maçlar henüz başlamadı — maç başlayınca URL gelir)")
        # Debug: kaç tane stream var ama canlı değil?
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000")
        for sport in ["basketball", "soccer"]:
            import urllib.request
            req = urllib.request.Request(
                f"{BILYONER_BASE}/live-score/event/v2/{sport}?date={today}",
                headers=BILYONER_HEADERS)
            try:
                data = json.loads(urllib.request.urlopen(req, context=ctx, timeout=10).read())
                stream_counts = {}
                for comp in data.get("competitions", []):
                    for evt in comp.get("events", []):
                        st = evt.get("streamType", "NONE")
                        ms = evt.get("matchStatus", {})
                        status = ms.get("type", str(ms)) if isinstance(ms, dict) else str(ms)
                        if st != "NONE":
                            key = f"{status}/isLive={evt.get('isLive',0)}"
                            stream_counts[key] = stream_counts.get(key, 0) + 1
                if stream_counts:
                    print(f"  [{sport}] Stream olan maçlar (durum/isLive): {stream_counts}")
            except Exception as e:
                print(f"  [{sport}] Debug sorgusu başarısız: {e}")
        return

    print(f"\n🔗 {len(all_matches)} maç için auth URL çekiliyor...")
    enriched = []
    for m in all_matches:
        sbs_id = m["sbsEventId"]
        auth = fetch_auth_url(sbs_id)
        if auth:
            enriched.append({**m, **auth})
        time.sleep(0.3)  # Rate limit

    # Hangi maçların URL'si var, hangisi yok — tam liste
    print(f"\n=== SONUÇ ===")
    for m in all_matches:
        found = any(e["sbsEventId"] == m["sbsEventId"] for e in enriched)
        icon = "✅" if found else "❌"
        print(f"  {icon} {m['sbsEventId']} | {m['homeTeam']} vs {m['awayTeam']} | {m['matchStatus']}")
    print(f"\n✅ {len(enriched)} stream URL hazır")

    if SUPABASE_URL and enriched:
        save_to_supabase(enriched)
    else:
        # Lokal test için stdout'a yaz
        print(json.dumps(enriched, ensure_ascii=False, indent=2))


def test_stream(sbs_id: int):
    """
    Tek bir maçın HLS URL'sini uçtan uca test et.
    Kullanım: python fetch_streams.py test 2886455
    """
    print(f"\n🧪 Stream testi: sbsEventId={sbs_id}")

    # Adım 1: Bilyoner auth
    auth = fetch_auth_url(sbs_id)
    if not auth:
        print("❌ Auth URL alınamadı")
        return

    auth_url = auth["authUrl"]
    print(f"  ✅ Auth URL: {auth_url[:80]}...")

    # Adım 2: Perform → HLS URL
    import urllib.request
    ctx = ssl.create_default_context()
    try:
        req = urllib.request.Request(auth_url, headers={"Accept": "application/json"})
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        data = json.loads(resp.read())
    except Exception as e:
        print(f"  ❌ Perform isteği başarısız: {e}")
        return

    launchers = data.get("launchInfo", {}).get("streamLauncher", [])
    if not launchers:
        print("  ❌ streamLauncher boş:", json.dumps(data, ensure_ascii=False)[:300])
        return

    print(f"\n✅ {len(launchers)} stream kalitesi:")
    for s in launchers:
        alias = s.get("playerAlias", "?")
        url   = s.get("launcherURL", "")
        print(f"\n  [{alias}]")
        print(f"  {url}")

    print("\n📱 VLC'de test: vlc '<url_yukari>'")
    print("🌐 Browser'da test: https://hls-js.netlify.app/demo/ → URL yapıştır")


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 3 and sys.argv[1] == "test":
        sbs_id = int(sys.argv[2])
        test_stream(sbs_id)
    else:
        main()
