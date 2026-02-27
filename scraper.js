// ─────────────────────────────────────────
// API SERVICE dart
// Canlı maçlar → Firebase Cloud Functions → API-Football
// Bitmiş maçlar → arsivMacDetay → Firestore (scraper verisi)
// ─────────────────────────────────────────

import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';
import 'dart:async';

import '../core/constants/api_config.dart';
import '../models/match_models.dart';

class Api {
  static final _client = http.Client();
  static const String _functionsUrl = ApiConfig.functionsUrl;

  // ── Canlı/yakın maçlar için Cloud Functions proxy ─────────────
  static Future<dynamic> _get(
    String endpoint, [
    Map<String, String>? params,
  ]) async {
    final queryParams = {'endpoint': endpoint, ...?params};
    final uri = Uri.parse('$_functionsUrl/macDetay')
        .replace(queryParameters: queryParams);
    debugPrint('🔵 CF GET $uri');
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    debugPrint('${res.statusCode == 200 ? '🟢' : '🔴'} ${res.statusCode} ← $endpoint');
    if (res.statusCode == 200) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return body['response'];
    }
    if (res.statusCode == 429) throw Exception('Rate limit — 1 dk bekleyin');
    if (res.statusCode == 403) throw Exception('Yetkisiz erişim');
    String msg = '${res.statusCode}';
    try { msg = (jsonDecode(res.body)['error'] ?? msg); } catch (_) {}
    throw Exception(msg);
  }

  // ── Arşiv maçlar için arsivMacDetay endpoint'i ────────────────
  static Future<dynamic> _getArchive(Map<String, String> params) async {
    final uri = Uri.parse('$_functionsUrl/arsivMacDetay')
        .replace(queryParameters: params);
    debugPrint('🗂 ARSIV GET $uri');
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    debugPrint('${res.statusCode == 200 ? '🟢' : '🔴'} ${res.statusCode} ← arsivMacDetay');
    if (res.statusCode == 200) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return body['response'];
    }
    if (res.statusCode == 404) return null; // Arşivde yok → boş döndür
    String msg = '${res.statusCode}';
    try { msg = (jsonDecode(res.body)['error'] ?? msg); } catch (_) {}
    throw Exception(msg);
  }

  static Future<void> triggerTodayUpdate() async {
    try {
      final uri = Uri.parse('$_functionsUrl/bugunuGuncelle');
      await _client.get(uri).timeout(const Duration(seconds: 20));
    } catch (_) {}
  }

  // ── Fixtures by date ──────────────────────────────────────────
  static Future<List<FixtureItem>> getFixturesByDate(DateTime date) async {
    final str = DateFormat('yyyy-MM-dd').format(date);
    final uri = Uri.parse('$_functionsUrl/maclarByDate')
        .replace(queryParameters: {'date': str});
    debugPrint('🔵 CF GET $uri');
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');

    final items = await compute(_parseFixturesBackground, res.body);

    // itemMap'e ekle — getEvents routing için lazım
    for (final item in items) {
      MatchCache.itemMap[item.fixture.id] = item;
    }
    return items;
  }

  // ── Events: bitmiş → arşiv, canlı → API-Football ─────────────
  static Future<List<FixtureEvent>> getEvents(int fixtureId) async {
    final item = MatchCache.itemMap[fixtureId];

    // Bitmiş maç + rawId varsa → Firestore arşivinden çek
    if (item != null &&
        item.fixture.status.isDone &&
        item.fixture.rawId != null) {
      final date = DateFormat('yyyy-MM-dd').format(item.fixture.date);
      final data = await _getArchive({
        'rawId': item.fixture.rawId!,
        'date':  date,
        'type':  'events',
      });
      if (data == null) return [];
      return (data as List)
          .map((e) => FixtureEvent.fromArchive(e as Map<String, dynamic>))
          .toList();
    }

    // Canlı / today_matches → API-Football
    final res = await _get(
      'fixtures/events',
      {'fixtureId': fixtureId.toString()},
    ) as List;
    return res.map((j) => FixtureEvent.fromJson(j)).toList();
  }

  // ── Statistics ────────────────────────────────────────────────
  static Future<List<FixtureStat>> getStats(int fixtureId) async {
    final res = await _get(
      'fixtures/statistics',
      {'fixtureId': fixtureId.toString()},
    ) as List;
    if (res.length < 2) return [];
    final homeStats = (res[0]['statistics'] as List? ?? []);
    final awayStats = (res[1]['statistics'] as List? ?? []);
    final List<FixtureStat> result = [];
    for (int i = 0; i < homeStats.length; i++) {
      result.add(FixtureStat(
        type:    homeStats[i]['type'] ?? '',
        homeVal: homeStats[i]['value'],
        awayVal: i < awayStats.length ? awayStats[i]['value'] : null,
      ));
    }
    return result;
  }

  // ── Standings ─────────────────────────────────────────────────
  static Future<List<StandingRow>> getStandings(int leagueId) async {
    final res = await _get(
      'standings',
      {'fixtureId': leagueId.toString()},
    ) as List;
    if (res.isEmpty) return [];
    final standings = res[0]['league']?['standings'] as List? ?? [];
    if (standings.isEmpty) return [];
    final table = standings[0] as List? ?? [];
    return table.map((j) => StandingRow.fromJson(j)).toList();
  }

  // ── Head-to-Head ──────────────────────────────────────────────
  static Future<List<FixtureItem>> getH2H(int homeId, int awayId) async {
    final res = await _get('fixtures/headtohead', {
      'homeId': homeId.toString(),
      'awayId': awayId.toString(),
    }) as List;
    return res.map((j) => FixtureItem.fromJson(j)).toList();
  }

  // ── Lineups ───────────────────────────────────────────────────
  static Future<List<Lineup>> getLineups(int fixtureId) async {
    final res = await _get(
      'fixtures/lineups',
      {'fixtureId': fixtureId.toString()},
    ) as List;
    return res.map((j) => Lineup.fromJson(j)).toList();
  }

  // ── Fixtures by IDs (Favoriler) ───────────────────────────────
  static Future<List<FixtureItem>> getFixturesByIds(List<int> ids) async {
    if (ids.isEmpty) return [];
    final uri = Uri.parse('$_functionsUrl/maclarByIds')
        .replace(queryParameters: {'ids': ids.take(20).join('-')});
    debugPrint('🔵 CF GET $uri');
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['response'] as List? ?? []);
    final items = list
        .map((j) => FixtureItem.fromJson(j as Map<String, dynamic>))
        .toList();

    // itemMap'e ekle
    for (final item in items) {
      MatchCache.itemMap[item.fixture.id] = item;
    }
    return items;
  }

  // ── Takım Ara ─────────────────────────────────────────────────
  static Future<List<TeamSearchResult>> searchTeams(String query) async {
    final uri = Uri.parse('$_functionsUrl/takimAra')
        .replace(queryParameters: {'q': query});
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['response'] as List? ?? [])
        .map((j) => TeamSearchResult.fromJson(j))
        .toList();
  }

  // ── Takımın Maçları ───────────────────────────────────────────
  static Future<List<FixtureItem>> getTeamFixtures(int teamId) async {
    final uri = Uri.parse('$_functionsUrl/takimMaclari')
        .replace(queryParameters: {'teamId': teamId.toString()});
    debugPrint('🔵 CF GET $uri');
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final items = (body['response'] as List? ?? [])
        .map((j) => FixtureItem.fromJson(j as Map<String, dynamic>))
        .toList();

    // itemMap'e ekle
    for (final item in items) {
      MatchCache.itemMap[item.fixture.id] = item;
    }
    return items;
  }

  // ── Takım Kadrosu ─────────────────────────────────────────────
  static Future<List<TeamPlayer>> getTeamSquad(int teamId) async {
    final uri = Uri.parse('$_functionsUrl/takimKadro')
        .replace(queryParameters: {'teamId': teamId.toString()});
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['response'] as List? ?? []);
    if (list.isEmpty) return [];
    final players = list[0]['players'] as List? ?? [];
    return players.map((j) => TeamPlayer.fromJson(j)).toList();
  }

  // ── Takım İstatistikleri ──────────────────────────────────────
  static Future<TeamStats> getTeamStats(int teamId) async {
    final uri = Uri.parse('$_functionsUrl/takimStats')
        .replace(queryParameters: {'teamId': teamId.toString()});
    final res = await _client.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return TeamStats.fromJson(body['response'] as Map<String, dynamic>);
  }
}

// ── 👷 ARKA PLAN İŞÇİSİ (Isolate) ────────────────────────────────
List<FixtureItem> _parseFixturesBackground(String responseBody) {
  final body = jsonDecode(responseBody) as Map<String, dynamic>;
  final list = (body['response'] as List? ?? []);
  return list
      .map((j) => FixtureItem.fromJson(j as Map<String, dynamic>))
      .toList();
}
