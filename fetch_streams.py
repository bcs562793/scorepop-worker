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

BILYONER_HEADERS = {
    "X-Auth-Token":         ACCESS_TOKEN,
    "PLATFORM-TOKEN":       PLATFORM_TOKEN,
    "X-DEVICE-ID":          DEVICE_ID,
    "X-CLIENT-CHANNEL":     "WEB",
    "X-CLIENT-APP-VERSION": APP_VERSION,
    "Accept":               "application/json",
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

            # Sadece canlı maçlar — FIXTURE henüz yayın başlamadı
            if status not in ("LIVE",):
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
                  f"[{stream_type}] — {status}")

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
        rows.append({
            "sbs_event_id":    m["sbsEventId"],
            "stream_auth_url": m["authUrl"],
            "stream_type":     m["streamType"],
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
        return

    print(f"\n🔗 {len(all_matches)} maç için auth URL çekiliyor...")
    enriched = []
    for m in all_matches:
        sbs_id = m["sbsEventId"]
        auth = fetch_auth_url(sbs_id)
        if auth:
            enriched.append({**m, **auth})
        time.sleep(0.3)  # Rate limit

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
