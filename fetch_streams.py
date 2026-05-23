"""
stream_manager.py — Supabase'deki stream URL'lerini okuyup
                    ffmpeg ile EC2'ye relay eder.

Bilyoner token'a gerek YOK — URL'ler GitHub Actions tarafından
Supabase'e yazılır, bu script sadece ffmpeg yönetir.

Ortam değişkenleri:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  SERVER_IP  (opsiyonel, varsayılan: 13.48.55.242)
"""

import os, json, time, subprocess, signal
import urllib.request, ssl
from datetime import datetime, timezone

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SERVER_IP    = os.environ.get("SERVER_IP", "13.48.55.242")
HLS_DIR      = "/var/www/hls"
ctx          = ssl.create_default_context()

# Çalışan ffmpeg prosesleri: {sbs_event_id: Popen}
active: dict[int, subprocess.Popen] = {}


def supabase_get() -> list[dict]:
    """Supabase'den aktif stream URL'lerini çek."""
    url = f"{SUPABASE_URL}/rest/v1/live_stream_urls?select=*"
    req = urllib.request.Request(url, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    })
    try:
        resp = urllib.request.urlopen(req, context=ctx, timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        print(f"  Supabase okuma hata: {e}")
        return []


def supabase_update_relay_url(sbs_id: int, relay_url: str):
    """Relay URL'yi Supabase'e güncelle."""
    url  = f"{SUPABASE_URL}/rest/v1/live_stream_urls?sbs_event_id=eq.{sbs_id}"
    data = json.dumps({"relay_url": relay_url}).encode()
    req  = urllib.request.Request(url, data=data, method="PATCH", headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
    })
    try:
        urllib.request.urlopen(req, context=ctx, timeout=10)
    except Exception as e:
        print(f"  Supabase update hata: {e}")


def start_ffmpeg(sbs_id: int, src_url: str, home: str, away: str) -> bool:
    out_m3u8 = f"{HLS_DIR}/stream_{sbs_id}.m3u8"
    out_seg  = f"{HLS_DIR}/stream_{sbs_id}_%d.ts"

    cmd = [
        "ffmpeg", "-y",
        "-i", src_url,
        "-c", "copy",
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_flags", "delete_segments+append_list",
        "-hls_segment_filename", out_seg,
        out_m3u8
    ]

    log = open(f"/tmp/stream_{sbs_id}.log", "w")
    proc = subprocess.Popen(cmd, stdout=log, stderr=log)
    active[sbs_id] = proc
    relay_url = f"http://{SERVER_IP}/hls/stream_{sbs_id}.m3u8"
    print(f"  ✅ {home} vs {away} → {relay_url}")

    time.sleep(3)  # ilk segmentlerin yazılmasını bekle

    # Supabase'e relay URL'yi güncelle
    supabase_update_relay_url(sbs_id, relay_url)
    return True


def stop_ffmpeg(sbs_id: int):
    proc = active.pop(sbs_id, None)
    if proc:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        print(f"  🛑 {sbs_id} relay durduruldu")


def run_once():
    now = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"\n[{now}] Supabase'den stream listesi alınıyor...")

    rows = supabase_get()
    if not rows:
        print("  Supabase'de stream yok")
        # Aktif prosesleri durdur
        for sid in list(active.keys()):
            stop_ffmpeg(sid)
        return

    current_ids = {int(r["sbs_event_id"]) for r in rows if r.get("stream_url")}
    print(f"  Supabase'de {len(current_ids)} stream var")

    # Yeni stream'leri başlat
    for row in rows:
        sbs_id = int(row["sbs_event_id"])
        src    = row.get("stream_url", "")
        if not src:
            continue

        if sbs_id in active:
            # Hâlâ çalışıyor mu?
            if active[sbs_id].poll() is None:
                continue
            else:
                print(f"  ⚠️  {sbs_id} crash etmiş, yeniden başlatılıyor")
                active.pop(sbs_id)

        print(f"  🎬 Başlatılıyor: {row.get('home_team')} vs {row.get('away_team')}")
        start_ffmpeg(sbs_id, src,
                     row.get("home_team","?"),
                     row.get("away_team","?"))

    # Bitenleri durdur
    ended = [sid for sid in list(active.keys()) if sid not in current_ids]
    for sid in ended:
        stop_ffmpeg(sid)

    print(f"  Aktif relay: {len(active)} stream")


if __name__ == "__main__":
    print(f"🚀 Stream Manager başlatıldı → http://{SERVER_IP}/hls/")
    while True:
        try:
            run_once()
        except Exception as e:
            print(f"  ❌ Hata: {e}")
        time.sleep(30)
