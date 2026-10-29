const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const allowedOrigins = [
  "https://greendasorte.github.io",
  "https://green-da-sorte.onrender.com",
  "https://green-da-sorte-2.onrender.com"
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origem não autorizada pelo CORS."));
  }
}));
app.use(express.json({ limit: "32kb" }));

// Small in-memory cache reduces provider/API costs between page visits.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const requestCounts = new Map();

function getCache(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function setCache(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}
function brazilDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
    !Number.isNaN(Date.parse(value + "T12:00:00Z"));
}
function limitAIRequests(req, res, next) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const current = requestCounts.get(ip);
  if (!current || current.resetAt <= now) {
    requestCounts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return next();
  }
  if (current.count >= 12) {
    return res.status(429).json({ error: "Muitas solicitações. Aguarde alguns minutos e tente novamente." });
  }
  current.count += 1;
  return next();
}

app.get("/", (_req, res) => {
  res.json({
    name: "Green da Sorte API",
    status: "online",
    provider: "football-data.org + OpenAI",
    footballConfigured: Boolean(FOOTBALL_DATA_API_KEY),
    aiConfigured: Boolean(OPENAI_API_KEY)
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    footballConfigured: Boolean(FOOTBALL_DATA_API_KEY),
    aiConfigured: Boolean(OPENAI_API_KEY),
    checkedAt: new Date().toISOString()
  });
});

async function footballData(path) {
  if (!FOOTBALL_DATA_API_KEY) {
    const error = new Error("FOOTBALL_DATA_API_KEY não está configurada no Render.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(FOOTBALL_DATA_BASE + path, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY, "Accept": "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || "A API de futebol retornou um erro.");
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getFixtures(date) {
  const key = "fixtures:" + date;
  const cached = getCache(key);
  if (cached) return cached;

  const data = await footballData("/matches?dateFrom=" + date + "&dateTo=" + date);
  const matches = (data.matches || []).map(match => ({
    id: match.id,
    date: match.utcDate,
    status: match.status,
    competition: {
      id: match.competition?.id,
      name: match.competition?.name || "Competição não informada"
    },
    homeTeam: { id: match.homeTeam?.id, name: match.homeTeam?.name || "Mandante" },
    awayTeam: { id: match.awayTeam?.id, name: match.awayTeam?.name || "Visitante" },
    score: {
      home: match.score?.fullTime?.home ?? null,
      away: match.score?.fullTime?.away ?? null
    }
  }));
  setCache(key, matches);
  return matches;
}

async function getStandings(competitionId) {
  if (!competitionId) return null;
  const key = "standings:" + competitionId;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const data = await footballData("/competitions/" + encodeURIComponent(competitionId) + "/standings");
    const table = (data.standings || []).find(item => item.type === "TOTAL")?.table || data.standings?.[0]?.table || [];
    const simplified = table.map(row => ({
      teamId: row.team?.id,
      team: row.team?.name,
      position: row.position,
      played: row.playedGames,
      won: row.won,
      draw: row.draw,
      lost: row.lost,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      points: row.points
    }));
    setCache(key, simplified);
    return simplified;
  } catch (error) {
    // Some competitions/plans do not expose standings. Do not invent missing stats.
    return null;
  }
}

function extractResponseText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  return (response.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(item => item.type === "output_text")
    .map(item => item.text || "")
    .join("\n");
}

async function generateTips(date, fixtures) {
  if (!OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY não está configurada no Render.");
    error.status = 503;
    throw error;
  }

  const upcoming = fixtures.filter(match =>
    ["SCHEDULED", "TIMED", "IN_PLAY", "PAUSED"].includes(match.status)
  ).slice(0, 12);

  if (!upcoming.length) {
    return {
      date,
      generatedAt: new Date().toISOString(),
      tips: [],
      message: "Não há partidas futuras disponíveis para esta data na fonte de dados."
    };
  }

  const competitionIds = [...new Set(upcoming.map(m => m.competition.id).filter(Boolean))].slice(0, 4);
  const standingsResults = await Promise.all(competitionIds.map(async id => [id, await getStandings(id)]));
  const standingsByCompetition = Object.fromEntries(standingsResults);

  const analysisInput = upcoming.map(match => ({
    ...match,
    standings: {
      home: (standingsByCompetition[match.competition.id] || []).find(row => row.teamId === match.homeTeam.id) || null,
      away: (standingsByCompetition[match.competition.id] || []).find(row => row.teamId === match.awayTeam.id) || null
    }
  }));

  const prompt = [
    "Você é um analista estatístico de futebol para o site brasileiro GREENdasorte.",
    "Use SOMENTE os dados fornecidos abaixo. Não invente forma recente, escalações, lesões, odds, resultados ou estatísticas ausentes.",
    "Para cada jogo, sugira no máximo 2 mercados dentre: BOTH_TEAMS_SCORE (ambas marcam), OVER_2_5 (mais de 2,5 gols), OVER_1_5 (mais de 1,5 gols), HOME_WIN (vitória do mandante), AWAY_WIN (vitória do visitante), DOUBLE_CHANCE_HOME (mandante ou empate), DOUBLE_CHANCE_AWAY (visitante ou empate).",
    "Se os dados forem insuficientes, use confiança 'baixa' e diga claramente que a análise é limitada. Não use a palavra 'certeiro' nem prometa lucro.",
    "A probabilidade deve ser uma estimativa analítica, não uma garantia; evite confiança alta sem evidências suficientes.",
    "Retorne APENAS JSON válido neste formato: { \"tips\": [{ \"matchId\": 123, \"homeTeam\": \"\", \"awayTeam\": \"\", \"competition\": \"\", \"kickoff\": \"ISO date\", \"market\": \"OVER_2_5\", \"selection\": \"Mais de 2,5 gols\", \"probability\": 55, \"confidence\": \"baixa|média|alta\", \"reason\": \"justificativa curta baseada nos dados\" }] }.",
    "Use somente IDs presentes nos jogos recebidos. Inclua até 8 sugestões no total, priorizando jogos com dados de classificação disponíveis.",
    "Data local solicitada: " + date + ".",
    "Jogos e estatísticas disponíveis: " + JSON.stringify(analysisInput)
  ].join("\n\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: "Responda em português brasileiro. Seja conservador, transparente sobre incerteza e retorne somente JSON.",
      input: prompt,
      text: { format: { type: "json_object" } },
      max_output_tokens: 2500,
      store: false
    }),
    signal: AbortSignal.timeout(45000)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || "A API de IA não conseguiu gerar os palpites.");
    error.status = response.status;
    throw error;
  }

  const raw = extractResponseText(body);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    const error = new Error("A resposta da IA não veio em formato válido. Tente novamente.");
    error.status = 502;
    throw error;
  }

  const byId = new Map(upcoming.map(match => [Number(match.id), match]));
  const allowedMarkets = new Set([
    "BOTH_TEAMS_SCORE", "OVER_2_5", "OVER_1_5", "HOME_WIN",
    "AWAY_WIN", "DOUBLE_CHANCE_HOME", "DOUBLE_CHANCE_AWAY"
  ]);
  const tips = (Array.isArray(parsed.tips) ? parsed.tips : []).slice(0, 8).flatMap(tip => {
    const match = byId.get(Number(tip.matchId));
    if (!match || !allowedMarkets.has(tip.market)) return [];
    const probability = Number(tip.probability);
    return [{
      matchId: match.id,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      competition: match.competition.name,
      kickoff: match.date,
      market: tip.market,
      selection: String(tip.selection || tip.market).slice(0, 80),
      probability: Number.isFinite(probability) ? Math.max(1, Math.min(99, Math.round(probability))) : null,
      confidence: ["baixa", "média", "alta"].includes(String(tip.confidence).toLowerCase()) ? String(tip.confidence).toLowerCase() : "baixa",
      reason: String(tip.reason || "Dados insuficientes para uma justificativa detalhada.").slice(0, 280)
    }];
  });

  return {
    date,
    generatedAt: new Date().toISOString(),
    source: "football-data.org + OpenAI",
    disclaimer: "Estimativas estatísticas, não garantias de resultado. Odds não são fornecidas por esta análise.",
    tips
  };
}

// Jogos reais de uma data, para o frontend.
app.get("/api/jogos", async (req, res) => {
  const date = req.query.date || brazilDateISO();
  if (!validDate(date)) return res.status(400).json({ error: "Data inválida. Use YYYY-MM-DD." });
  try {
    const matches = await getFixtures(date);
    return res.json({ date, matches, source: "football-data.org" });
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.message || "Não foi possível carregar os jogos." });
  }
});

// Palpites gerados pela IA com base nos jogos e nas classificações reais disponíveis.
app.get("/api/palpites", limitAIRequests, async (req, res) => {
  const date = req.query.date || brazilDateISO();
  if (!validDate(date)) return res.status(400).json({ error: "Data inválida. Use YYYY-MM-DD." });

  const key = "tips:" + date;
  const cached = getCache(key);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const fixtures = await getFixtures(date);
    const result = await generateTips(date, fixtures);
    setCache(key, result, CACHE_TTL_MS);
    return res.json({ ...result, cached: false });
  } catch (error) {
    return res.status(error.status || 502).json({
      error: error.message || "Não foi possível gerar os palpites.",
      hint: "Confira as variáveis FOOTBALL_DATA_API_KEY e OPENAI_API_KEY nas configurações do serviço no Render."
    });
  }
});

// Rotas antigas mantidas para compatibilidade com integrações anteriores.
const API_BASE = "https://api.api-futebol.com.br/v1";
const API_KEY = process.env.API_FUTEBOL_KEY;
async function apiFutebol(path, res) {
  if (!API_KEY) {
    return res.status(503).json({ error: "API_FUTEBOL_KEY não configurada no Render.", provider: "API Futebol" });
  }
  try {
    const response = await fetch(API_BASE + path, {
      headers: { Authorization: "Bearer " + API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const bodyText = await response.text();
    let data;
    try { data = bodyText ? JSON.parse(bodyText) : null; }
    catch { data = { message: bodyText }; }
    if (!response.ok) return res.status(response.status).json({
      error: "A API Futebol retornou um erro.", providerStatus: response.status, details: data
    });
    return res.json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Não foi possível consultar a API Futebol.",
      details: error.name === "TimeoutError" ? "Tempo limite excedido." : error.message
    });
  }
}
app.get("/api/campeonatos", (_req, res) => apiFutebol("/campeonatos", res));
app.get("/api/campeonatos/:campeonatoId/fases", (req, res) => {
  const { campeonatoId } = req.params;
  if (!/^\d+$/.test(campeonatoId)) return res.status(400).json({ error: "ID de campeonato inválido." });
  return apiFutebol("/campeonatos/" + campeonatoId + "/fases", res);
});
app.get("/api/campeonatos/:campeonatoId/fases/:faseId", (req, res) => {
  const { campeonatoId, faseId } = req.params;
  if (!/^\d+$/.test(campeonatoId) || !/^\d+$/.test(faseId)) {
    return res.status(400).json({ error: "ID de campeonato ou fase inválido." });
  }
  return apiFutebol("/campeonatos/" + campeonatoId + "/fases/" + faseId, res);
});

app.listen(PORT, () => console.log("Green da Sorte API ouvindo na porta " + PORT));
