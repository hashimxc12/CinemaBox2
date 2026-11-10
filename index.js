'use strict';

const BASE = 'https://cinema.albox.co/api/v4';
const CINEMETA = 'https://v3-cinemeta.strem.io';

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

function request(url, options) {
  var headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
    'Referer': 'https://cinema.albox.co/',
    'Origin': 'https://cinema.albox.co',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (options && options.headers) {
    Object.keys(options.headers).forEach(function(k) { headers[k] = options.headers[k]; });
  }
  return fetch(url, { headers: headers })
  .then(function (response) {
    return response.text().then(function (body) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
      try { return JSON.parse(body); } catch (e) { throw new Error('Invalid JSON'); }
    });
  });
}

function api(path) {
  return request(BASE + '/' + path);
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

function getPlayer(episodeId) {
  return cached('player-' + episodeId, function () {
    // تجربة نقطة النهاية القديمة أولاً
    return api('shows/episodes/player/' + episodeId).then(function(data) {
      // إذا لم تكن هناك روابط، نجرب نقطة النهاية الجديدة
      if (!data.videos || data.videos.length === 0) {
        console.log('[TRYING WATCH ENDPOINT]');
        return api('stream/watch/' + episodeId).catch(function() {
          return data; // إرجاع البيانات القديمة حتى لو فارغة
        });
      }
      return data;
    });
  }, 30000);
}

function getExternalMeta(type, id) {
  return cached('external-' + type + '-' + id, function () {
    return request(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json').then(function (data) {
      return (data && data.meta) ? data.meta : { name: '', original_name: '', year: '' };
    }).catch(function() {
      return { name: '', original_name: '', year: '' };
    });
  }, 600000);
}

function searchCinemaBox(title, type, year) {
  if (!title) return Promise.resolve(null);
  return cached('search-' + type + '-' + normalizeTitle(title) + '-' + (year || ''), function () {
    var queries = [title];
    if (year && year !== '1900') queries.push(title + ' ' + year);
    var foundItems = new Map();

    function fetchAllQueries(qIndex) {
      if (qIndex >= queries.length) return Promise.resolve(foundItems);
      var term = queries[qIndex];

      function fetchPage(pageNum) {
        if (pageNum > 5) return Promise.resolve();
        var queryStr = 'page_size=25&page_number=' + pageNum + '&term=' + encodeURIComponent(term);
        return api('search?' + queryStr).then(function (data) {
          var results = (data.results || []).filter(function (item) {
            return normalizeType(item.type) === type;
          });
          results.forEach(function (item) {
            if (item.id) foundItems.set(String(item.id), item);
          });
          if ((data.results || []).length < 25) return Promise.resolve();
          return fetchPage(pageNum + 1);
        }).catch(function() { return Promise.resolve(); });
      }
      return fetchPage(1).then(function () { return fetchAllQueries(qIndex + 1); });
    }

    return fetchAllQueries(0).then(function (items) {
      var queryTitle = normalizeTitle(title);
      var ranked = [];
      items.forEach(function (item) {
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
      if (best && best.score >= 0.50) {
        console.log('[MATCH]', title, '=>', best.item.title, 'ID:', best.item.id);
        return best.item;
      }
      return null;
    });
  }, 600000);
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

function fetchStreams(type, id, tmdbTitles) {
  var episodeId = null;
  var external = parseExternalId(id);

  if (!external) return Promise.resolve({ streams: [] });

  return getExternalMeta(type, external.imdbId).then(function (meta) {
    var year = releaseYear(meta.year);
    
    var allTitles = [];
    if (tmdbTitles && tmdbTitles.length) {
        tmdbTitles.forEach(function(t) { if (allTitles.indexOf(t) === -1) allTitles.push(t); });
    }
    if (meta.name && allTitles.indexOf(meta.name) === -1) allTitles.push(meta.name);
    if (meta.original_name && allTitles.indexOf(meta.original_name) === -1) allTitles.push(meta.original_name);
    
    function trySearchTitle(index) {
        if (index >= allTitles.length) return Promise.resolve(null);
        console.log('[SEARCHING WITH TITLE]', allTitles[index]);
        return searchCinemaBox(allTitles[index], type, year).then(function (found) {
            if (found) return found;
            return trySearchTitle(index + 1);
        });
    }
    
    return trySearchTitle(0);
  })
  .then(function (found) {
    if (!found) return null;
    return getDetails(found.id).then(function (details) {
      var post = details.post_info;
      if (!post) return null;

      if (type === 'movie') {
        episodeId = post.episode_id;
        return episodeId;
      }
      if (!external.season || !external.episode) return null;
      return findEpisode(details, found.id, external.season, external.episode);
    });
  })
  .then(function (resolvedEpisodeId) {
    episodeId = resolvedEpisodeId;
    if (!episodeId) return { streams: [] };

    return getPlayer(episodeId).then(function (player) {
      var streams = [];
      (player.videos || []).forEach(function (video) {
        if (video.url && /^https?:\/\//i.test(video.url)) {
          var quality = video.quality || 'Video';
          streams.push({ name: 'Cinema Box · ' + quality, title: quality + ' • Cinema Box', url: video.url });
        }
      });
      return { streams: streams };
    });
  })
  .catch(function (error) {
    console.error('[STREAM ERROR]', error.message);
    return { streams: [] };
  });
}

function getStreamsForNuvio(input, mediaType, season, episode) {
  return Promise.resolve().then(function () {
    var args = input && typeof input === 'object' ? input : { tmdbId: input, mediaType: mediaType, season: season, episode: episode };
    var rawType = String(args.mediaType || 'movie').toLowerCase();
    var oldType = rawType === 'tv' ? 'series' : rawType;
    
    var tmdbTitles = [];
    var tmdbId = args.tmdbId;
    var apiKey = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';

    // 1. جلب الاسم العربي من TMDB مباشرة
    var tmdbPromise = Promise.resolve();
    if (apiKey) {
        var kind = (rawType === 'tv' || rawType === 'series') ? 'tv' : 'movie';
        var tmdbUrl = 'https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(tmdbId) + '?api_key=' + encodeURIComponent(apiKey) + '&language=ar';
        tmdbPromise = request(tmdbUrl).then(function(data) {
            if (data.name) tmdbTitles.push(data.name);
            if (data.original_name && data.original_name !== data.name) tmdbTitles.push(data.original_name);
            if (data.title) tmdbTitles.push(data.title);
            if (data.original_title && data.original_title !== data.title) tmdbTitles.push(data.original_title);
        }).catch(function(e) { 
            console.log('[TMDB TITLE ERROR]', e.message); 
        });
    }

    return tmdbPromise.then(function() {
        return resolveImdbId(tmdbId, rawType);
    }).then(function (imdbId) {
      if (!imdbId) return [];
      var id = imdbId;
      if (oldType === 'series') {
        if (args.season == null || args.episode == null) return [];
        id += ':' + Number(args.season) + ':' + Number(args.episode);
      }
      return fetchStreams(oldType, id, tmdbTitles).then(function (result) {
        return Array.isArray(result && result.streams) ? result.streams : [];
      });
    });
  }).catch(function (error) {
    console.error('[NUVIO ERROR]', error);
    return [];
  });
}

// تصدير متوافق مع Nuvio (Promise-based)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreamsForNuvio };
} else {
  global.getStreams = getStreamsForNuvio;
}
