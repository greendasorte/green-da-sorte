const express = require("express");

const router = express.Router();
const BASE_URL = "https://sportsapi.com.br/api/v1";
const API_KEY = process.env.SPORTSAPI_API_KEY;

const cache = new Map();
const inFlight = new Map();
const DEFAULT_TTL = 30 * 1000;
const DETAILS_TTL = 60 * 1000;
const META_TTL = 5 * 60 * 1000;
const STALE_TTL = 5 * 60 * 1000;

function sendCached(res, item, state) {
  res.set("X-Data-Cache", state);
  return res.json(item.data);
}

function forwardHeaders(upstream, res) {
  for (const name of ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "x-request-id", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) res.set(name, value);
  }
}

async function requestProvider(path, res, ttl = DEFAULT_TTL) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "SPORTSAPI_API_KEY não configurada no servidor Render.",
      provider: "SportsAPI",
      code: "API_KEY_NOT_CONFIGURED"
    });
  }

  const key = path;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.savedAt < ttl) {
    return sendCached(res, cached, "HIT");
  }

  try {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const upstream = await fetch(BASE_URL + path, {
          method: "GET",
          headers: { "X-API-Key": API_KEY, Accept: "application/json" },
          signal: AbortSignal.timeout(15000)
        });
        const raw = await upstream.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch { data = { error: "A SportsAPI retornou uma resposta não JSON." }; }
        return { upstream, data };
      })();
      inFlight.set(key, pending);
    }

    const { upstream, data } = await pending;
    forwardHeaders(upstream, res);

    if (!upstream.ok) {
      if ((upstream.status === 500 || upstream.status === 503) && cached && Date.now() - cached.savedAt < STALE_TTL) {
        return sendCached(res, cached, "STALE");
      }
      return res.status(upstream.status).json({
        error: "A SportsAPI retornou um erro.",
        provider: "SportsAPI",
        providerStatus: upstream.status,
        details: data,
        requestId: upstream.headers.get("x-request-id") || data.requestId || null
      });
    }

    const item = { data, savedAt: Date.now() };
    cache.set(key, item);
    return sendCached(res, item, "MISS");
  } catch (error) {
    if (cached && Date.now() - cached.savedAt < STALE_TTL) {
      return sendCached(res, cached, "STALE");
    }
    return res.status(502).json({
      error: "Não foi possível consultar a SportsAPI.",
      provider: "SportsAPI",
      details: error.name === "TimeoutError" ? "Tempo limite excedido." : error.message
    });
  } finally {
    inFlight.delete(key);
  }
}

function queryString(query, allowed) {
  const params = new URLSearchParams();
  for (const name of allowed) {
    const value = query[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(name, String(value).trim());
    }
  }
  return params.toString();
}

// Somente parâmetros descritos na documentação pública da SportsAPI.
const GAME_FILTERS = [
  "sport", "date", "q", "status", "statusIn", "matchId", "competitionId",
  "teamId", "homeTeamId", "awayTeamId", "competition", "league", "region",
  "team", "homeTeam", "awayTeam", "venue", "city", "tvNetwork",
  "stage", "round", "roundNumber", "eventType", "startsAfter", "startsBefore",
  "minHomeScore", "maxHomeScore", "minAwayScore", "maxAwayScore",
  "minTotalScore", "maxTotalScore", "hasScore", "hasVenue", "hasBroadcast",
  "hasOfficials", "hasEvents", "hasStandings", "hasLiveClock", "sortBy",
  "sortOrder", "limit", "offset"
];

router.get("/status", async (_req, res) => {
  return requestProvider("/account", res, META_TTL);
});

router.get("/account", async (_req, res) => requestProvider("/account", res, META_TTL));
router.get("/sports", async (_req, res) => requestProvider("/sports", res, META_TTL));

router.get("/games", async (req, res) => {
  const date = req.query.date;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: "date deve usar o formato YYYY-MM-DD." });
  }
  if (req.query.limit && (!/^\d+$/.test(String(req.query.limit)) || Number(req.query.limit) < 1 || Number(req.query.limit) > 100)) {
    return res.status(400).json({ error: "limit deve ser um número entre 1 e 100." });
  }
  if (req.query.offset && !/^\d+$/.test(String(req.query.offset))) {
    return res.status(400).json({ error: "offset deve ser um número inteiro maior ou igual a zero." });
  }
  const qs = queryString(req.query, ["sport", "date", "competition", "region", "team", "status", "limit", "offset"]);
  return requestProvider("/games" + (qs ? "?" + qs : ""), res, DEFAULT_TTL);
});

router.get("/games/filter", async (req, res) => {
  const date = req.query.date;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: "date deve usar o formato YYYY-MM-DD." });
  }
  const qs = queryString(req.query, GAME_FILTERS);
  return requestProvider("/games/filter" + (qs ? "?" + qs : ""), res, DEFAULT_TTL);
});

router.get("/games/:id/details", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: "ID de partida inválido." });
  const qs = queryString(req.query, ["sport", "date"]);
  return requestProvider("/games/" + encodeURIComponent(id) + "/details" + (qs ? "?" + qs : ""), res, DETAILS_TTL);
});

router.get("/games/:id/odds", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: "ID de partida inválido." });
  const qs = queryString(req.query, ["sport", "date", "market", "bookmaker"]);
  return requestProvider("/games/" + encodeURIComponent(id) + "/odds" + (qs ? "?" + qs : ""), res, DETAILS_TTL);
});

module.exports = router;
