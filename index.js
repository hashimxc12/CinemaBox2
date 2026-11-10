'use strict';

const BASE_URLS = [
  'https://cinema.albox.co/api/v4',
  'https://cinema2.albox.co/api/v4'
];
const CINEMETA = 'https://v3-cinemeta.strem.io';

const DEFAULT_TIMEOUT = 4000; // 4 ثوانٍ كحد أقصى

const cache = new Map();

function cached(key, loader, ttl) {
  if (ttl == null) ttl = 120000;
  const old = cache.get(key);
  if (old && Date.now() - old.time < ttl) return old.value;

  const value = Promise.resolve().then(loader).catch(function (error) {
    cache.delete(key);
    throw error;
  });

  cache.set(key, { time: Date.now(), value: value });
  return value;
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, DEFAULT_TIMEOUT);

  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function (res) {
      clearTimeout(timer);
      return res;
    })
    .catch(function (err) {
      clearTimeout(timer);
      throw err;
    });
}

function request(url) {
  return fetchWithTimeout(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Referer': 'https://cinema.albox.co/',
      'Origin': 'https://cinema.albox.co',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  })
  .then(function (response) {
    return response.text().then(function (body) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
      try { return JSON.parse(body); } catch (e) { throw new Error('Invalid JSON'); }
    });
  });
}

function api(path, domainIndex) {
  if (domainIndex == null) domainIndex = 0;
  if (domainIndex >= BASE_URLS.length) {
    return Promise.reject(new Error('All Cinema Box domains failed'));
  }
  
  var baseUrl = BASE_URLS[domainIndex];
  return request(baseUrl + '/' + path).catch(function(error) {
    return api(path, domainIndex + 1);
  });
}

function normalizeType(value) {
  return String(value || '').toUpperCase() === 'MOVIE' ? 'movie' : 'series';
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleScore(a, b) {
  var x = normalizeTitle(a);
  var y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  var xs = new Set(x.split(' '));
  var ys = new Set(y.split(' '));
  var common = 0;
  xs.forEach(function (word) { if (ys.has(word)) common++; });
  return (2 * common) / (xs.size + ys.size);
}

function releaseYear(value) {
  if (!value) return undefined;
  var number = Number(value);
  if (Number.isFinite(number) && number > 1000000000) return String(new Date(number).getFullYear());
  var match = String(value).match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : undefined;
}

function getDetails(id, seasonId) {
  var suffix = seasonId ? '?season_id=' + encodeURIComponent(seasonId) : '';
  var key = 'details-' + id + '-' + (seasonId || 'default');
  return cached(key, function () {
    return api('shows/shows/dynamic/' + id + suffix);
  });
}

// 🚀 السرعة القصوى: إرسال 3 طلبات لجلب الدقة في نفس الوقت
function getPlayer(episodeId) {
  return cached('player-' + episodeId, function () {
    var endpoints = [
      'shows/episodes/player/' + episodeId,
      'stream/watch/' + episodeId,
      'shows/episodes/watch/' + episodeId
    ];

    var requests = endpoints.map(function(endpoint) {
      return api(endpoint).catch(function() { return null; });
    });

    return new Promise(function(resolve) {
      var pending = requests.length;
      var resolved = false;

      requests.forEach(function(p) {
        p.then(function(data) {
          pending--;
          if (!resolved && data && data.videos && data.videos.length > 0) {
            resolved = true;
            resolve(data); // أول مسار يعطي نتيجة، نأخذها فوراً
          } else if (pending === 0 && !resolved) {
            resolve({ videos: [] });
          }
        }).catch(function() {
          pending--;
          if (pending === 0 && !resolved) resolve({ videos: [] });
        });
      });
    });
  }, 30000);
}

function getCinemetaMeta(type, id) {
  return cached('cinemeta-' + type + '-' + id, function () {
    return request(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json').then(function (data) {
      return (data && data.meta) ? data.meta : { name: '', original_name: '', year: '' };
    }).catch(function () {
      return { name: '', original_name: '', year: '' };
    });
  }, 600000);
}

function searchCinemaBoxFast(title, type, year) {
  if (!title) return Promise.resolve(null);
  var queryStr = 'page_size=25&page_number=1&term=' + encodeURIComponent(title);
  
  return api('search?' + queryStr).then(function (data) {
    var results = (data.results || []).filter(function (item) {
      return normalizeType(item.type) === type;
    });
    
    var queryTitle = normalizeTitle(title);
    var ranked = [];
    results.forEach(function (item) {
      var candidateTitle = normalizeTitle(item.title);
      var score = titleScore(title, item.title);
      var resultYear = releaseYear(item.year);

      if (queryTitle !== candidateTitle && queryTitle.split(' ').length === 1 && candidateTitle.split(' ').length > 1) score = 0;
      if (year && resultYear && resultYear !== '1900') {
        if (year === resultYear) score += 0.1;
        else score -= 0.1;
      }
      ranked.push({ item: item, score: score });
    });
    ranked.sort(function (a, b) { return b.score - a.score; });

    var best = ranked[0];
    if (best && best.score >= 0.50) return best.item;
    return null;
  }).catch(function () { return null; });
}

function parseExternalId(id) {
  var match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/);
  if (!match) return null;
  return {
    imdbId: match[1],
    season: match[2] ? Number(match[2]) : null,
    episode: match[3] ? Number(match[3]) : null
  };
}

function findEpisode(details, showId, seasonNumber, episodeNumber) {
  var seasonDetails = details;
  var currentSeason = Number((details.post_info && details.post_info.season_number) || 1);
  var seasonPromise = Promise.resolve(seasonDetails);

  if (seasonNumber !== currentSeason) {
    var seasonCards = [];
    (details.sections || []).forEach(function (section) {
      (section.data || []).forEach(function (item) {
        if (String(item.card_type || '').toLowerCase() === 'seasonposter' && item.id) seasonCards.push(item);
      });
    });

    var seasonCard = null;
    for (var i = 0; i < seasonCards.length; i++) {
      var match = String(seasonCards[i].title || '').match(/\d+/);
      if (match && Number(match[0]) === seasonNumber) { seasonCard = seasonCards[i]; break; }
    }

    if (!seasonCard) return Promise.resolve(null);

    seasonPromise = getDetails(showId, seasonCard.id).then(function (loaded) {
      var loadedSeason = Number((loaded.post_info && loaded.post_info.season_number) || 0);
      if (loadedSeason !== seasonNumber) return null;
      return loaded;
    });
  }

  return seasonPromise.then(function (sd) {
    if (!sd) return null;
    var section = null;
    (sd.sections || []).forEach(function (s) {
      if (s.section_type === 'episodes' || (s.data || []).some(function (item) {
        return String(item.card_type || '').toLowerCase() === 'episode';
      })) {
        if (!section) section = s;
      }
    });

    var episodes = [];
    if (section) {
      (section.data || []).forEach(function (item) {
        if (item.id && String(item.card_type || '').toLowerCase() === 'episode') episodes.push(item);
      });
    }

    for (var idx = 0; idx < episodes.length; idx++) {
      var parsed = Number(episodes[idx].description);
      var number = (Number.isFinite(parsed) && parsed > 0) ? parsed : idx + 1;
      if (number === episodeNumber) return episodes[idx].id;
    }
    return null;
  });
}

function resolveImdbId(id, mediaType) {
  var value = String(id || '').replace(/^imdb:/i, '');
  if (/^tt\d+$/i.test(value)) return Promise.resolve(value);

  var key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';
  if (!key) return Promise.reject(new Error('TMDB_API_KEY is missing'));

  var kind = (String(mediaType).toLowerCase() === 'tv' || String(mediaType).toLowerCase() === 'series') ? 'tv' : 'movie';
  return request('https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(value) + '/external_ids?api_key=' + encodeURIComponent(key))
    .then(function (data) { return data && data.imdb_id ? data.imdb_id : null; });
}

function buildStreamObject(video) {
  var quality = video.quality || video.resolution || 'Video';
  var obj = {
    name: 'Cinema Box · ' + quality,
    title: quality + ' • Cinema Box',
    url: video.url,
    quality: quality,
    headers: {
      'Referer': 'https://cinema.albox.co/',
      'Origin': 'https://cinema.albox.co',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'
    },
    provider: 'cinemabox'
  };

  if (video.subtitle_url) {
    obj.subtitles = [{ url: video.subtitle_url, language: 'ar', name: 'العربية' }];
  }
  return obj;
}

function cleanAndSortStreams(streams) {
  var seen = new Set();
  var unique = [];
  streams.forEach(function (s) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  });

  var order = { '4K': 4, '2160p': 3, '1080p': 2, '720p': 1, '480p': 0 };
  unique.sort(function (a, b) {
    var qa = order[a.quality] || 0;
    var qb = order[b.quality] || 0;
    return qb - qa;
  });
  return unique;
}

function getStreamsForNuvio(input, mediaType, season, episode) {
  return Promise.resolve().then(function () {
    var args = input && typeof input === 'object' ? input : { tmdbId: input, mediaType: mediaType, season: season, episode: episode };
    var rawType = String(args.mediaType || 'movie').toLowerCase();
    var oldType = rawType === 'tv' ? 'series' : rawType;
    var tmdbId = args.tmdbId;
    var apiKey = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';
    var isImdb = String(tmdbId).startsWith('tt');

    var titles = [];
    var year = null;
    var metaPromise;

    // 🚀 تخطي Cinemeta إذا استخدمنا TMDB لتسريع العملية
    if (!isImdb && apiKey) {
      var kind = (oldType === 'series') ? 'tv' : 'movie';
      var baseUrl = 'https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(tmdbId);
      
      var reqs = [
        request(baseUrl + '?api_key=' + apiKey + '&language=ar').catch(function(){ return {}; }),
        request(baseUrl + '?api_key=' + apiKey + '&language=en').catch(function(){ return {}; })
      ];

      metaPromise = Promise.all(reqs).then(function(results) {
        var ar = results[0] || {};
        var en = results[1] || {};
        
        if (ar.name) titles.push(ar.name);
        if (ar.title) titles.push(ar.title);
        if (en.name) titles.push(en.name);
        if (en.title) titles.push(en.title);
        
        titles = titles.filter(function(item, pos) { return titles.indexOf(item) == pos; });
        var date = ar.release_date || ar.first_air_date || en.release_date || en.first_air_date;
        if (date) year = date.split('-')[0];
      });
    } else {
      // إذا كان IMDb، نستخدم Cinemeta
      metaPromise = getCinemetaMeta(oldType, tmdbId).then(function(meta) {
        if (meta.name) titles.push(meta.name);
        if (meta.original_name) titles.push(meta.original_name);
        year = releaseYear(meta.year);
      });
    }

    return metaPromise.then(function () {
      return resolveImdbId(tmdbId, rawType);
    }).then(function (imdbId) {
      if (!imdbId) return [];
      var id = imdbId;
      if (oldType === 'series') {
        if (args.season == null || args.episode == null) return [];
        id += ':' + Number(args.season) + ':' + Number(args.episode);
      }
      
      var external = parseExternalId(id);
      if (!external) return [];

      // البحث المتوازي بكل الأسماء المتاحة
      var searchPromises = titles.map(function(t) {
        return searchCinemaBoxFast(t, oldType, year);
      });

      return new Promise(function(resolve) {
        var resolved = false;
        var pending = searchPromises.length;
        if (pending === 0) return resolve(null);

        searchPromises.forEach(function(p) {
          p.then(function(found) {
            if (!resolved && found) {
              resolved = true;
              resolve(found);
            } else if (!found) {
              pending--;
              if (pending === 0 && !resolved) resolve(null);
            }
          }).catch(function() {
            pending--;
            if (pending === 0 && !resolved) resolve(null);
          });
        });
      });
    }).then(function (found) {
      if (!found) return null;
      return getDetails(found.id).then(function (details) {
        var post = details.post_info;
        if (!post) return null;
        if (oldType === 'movie') return post.episode_id;
        
        var external = parseExternalId(String(tmdbId).includes(':') ? tmdbId : tmdbId + ':' + season + ':' + episode);
        if (!external || !external.season || !external.episode) return null;
        return findEpisode(details, found.id, external.season, external.episode);
      });
    }).then(function (episodeId) {
      if (!episodeId) return { streams: [] };

      return getPlayer(episodeId).then(function (player) {
        var streams = [];
        (player.videos || []).forEach(function (video) {
          if (video.url && /^https?:\/\//i.test(video.url)) {
            streams.push(buildStreamObject(video));
          }
        });
        streams = cleanAndSortStreams(streams);
        return { streams: streams };
      });
    }).then(function(result) {
      return Array.isArray(result && result.streams) ? result.streams : [];
    });
  }).catch(function (error) {
    console.error('[NUVIO ERROR]', error);
    return [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreamsForNuvio };
} else {
  global.getStreams = getStreamsForNuvio;
}
