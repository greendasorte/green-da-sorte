const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://api.football-data.org/v4";
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// Cache simples para respeitar o limite gratuito de 10 chamadas por minuto.
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const COMPETITIONS_TTL_MS = 60 * 60 * 1000;

app.use(cors({
  origin: [
    "https://greendasorte.github.io",
    "https://green-da-sorte.onrender.com",
    "https://green-da-sorte-2.onrender.com"
  ]
}));
app.use(express.json());

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

function dataHojeBrasil() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

async function footballData(path, cacheKey, ttl = CACHE_TTL_MS) {
  if (!API_TOKEN) {
    const error = new Error("FOOTBALL_DATA_TOKEN não configurada no Render.");
    error.status = 503;
    throw error;
  }

  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
  }

  const response = await fetch(API_BASE + path, {
    headers: {
      "X-Auth-Token": API_TOKEN,
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  const bodyText = await response.text();
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    data = { message: bodyText };
  }

  if (!response.ok) {
    const error = new Error("A football-data.org retornou um erro.");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return cacheKey ? cacheSet(cacheKey, data, ttl) : data;
}

function sendApiError(res, error) {
  console.error("FOOTBALL-DATA API ERROR:", error.status || "", error.message);
  return res.status(error.status || 502).json({
    error: error.message || "Não foi possível consultar football-data.org.",
    provider: "football-data.org",
    details: error.details || undefined
  });
}

app.get("/", (_req, res) => {
  res.json({
    name: "Green da Sorte API",
    status: "online",
    provider: "football-data.org",
    keyConfigured: Boolean(API_TOKEN)
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    provider: "football-data.org",
    configured: Boolean(API_TOKEN),
    checkedAt: new Date().toISOString()
  });
});

// Retorna apenas as competições que a própria conta consegue acessar.
app.get("/api/campeonatos", async (_req, res) => {
  try {
    const data = await footballData("/competitions", "competitions", COMPETITIONS_TTL_MS);
    const list = Array.isArray(data?.competitions) ? data.competitions : [];
    return res.json(list.map(competition => ({
      id: competition.id,
      campeonato_id: competition.id,
      nome: competition.name,
      nome_popular: competition.name,
      code: competition.code,
      area: competition.area?.name || null,
      emblem: competition.emblem || null,
      currentSeason: competition.currentSeason || null,
      provider: "football-data.org"
    })));
  } catch (error) {
    return sendApiError(res, error);
  }
});

// Jogos do dia de uma competição liberada para o token configurado.
app.get("/api/campeonatos/:campeonatoId/jogos-hoje", async (req, res) => {
  const id = String(req.params.campeonatoId || "");
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "ID de campeonato inválido." });
  }

  const hoje = dataHojeBrasil();
  try {
    const competitionsData = await footballData("/competitions", "competitions", COMPETITIONS_TTL_MS);
    const competitions = Array.isArray(competitionsData?.competitions)
      ? competitionsData.competitions
      : [];
    const competition = competitions.find(item => String(item.id) === id);

    if (!competition) {
      return res.status(404).json({
        error: "Este campeonato não está disponível na lista retornada pela sua conta football-data.org.",
        campeonato_id: Number(id),
        data: hoje,
        total: 0,
        partidas: []
      });
    }

    const competitionCode = competition.code || id;
    const cacheKey = "matches:" + competitionCode + ":" + hoje;
    const data = await footballData(
      "/competitions/" + encodeURIComponent(competitionCode) +
        "/matches?dateFrom=" + hoje + "&dateTo=" + hoje,
      cacheKey,
      CACHE_TTL_MS
    );

    const matches = Array.isArray(data?.matches) ? data.matches : [];
    const partidas = matches.map(match => ({
      id: match.id,
      partida_id: match.id,
      data_hora_realizacao: match.utcDate || null,
      date: match.utcDate || null,
      status: match.status || null,
      situacao: match.status || null,
      time_mandante: { nome: match.homeTeam?.name || "A definir" },
      time_visitante: { nome: match.awayTeam?.name || "A definir" },
      placar_mandante: match.score?.fullTime?.home ?? null,
      placar_visitante: match.score?.fullTime?.away ?? null,
      campeonato: competition.name,
      rodada: match.matchday ?? null,
      venue: match.venue || null
    }));

    return res.json({
      provider: "football-data.org",
      campeonato_id: competition.id,
      campeonato: competition.name,
      codigo: competition.code,
      data: hoje,
      total: partidas.length,
      partidas,
      aviso: "Plano gratuito: horários e resultados podem ter atraso. Odds não são fornecidas por este endpoint."
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.get("/api/diagnostico/campeonatos/:campeonatoId", async (req, res) => {
  try {
    const data = await footballData("/competitions", "competitions", COMPETITIONS_TTL_MS);
    const list = Array.isArray(data?.competitions) ? data.competitions : [];
    const competition = list.find(item => String(item.id) === String(req.params.campeonatoId));
    return res.json({
      provider: "football-data.org",
      campeonato_id: Number(req.params.campeonatoId),
      campeonato_encontrado: Boolean(competition),
      campeonato: competition || null,
      total_competicoes_disponiveis: list.length,
      consultado_em: new Date().toISOString()
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// Classificação da competição (quando disponível no plano da football-data.org).
app.get("/api/campeonatos/:campeonatoId/classificacao", async (req, res) => {
  const id = String(req.params.campeonatoId || "");
  if (!/^\\d+$/.test(id)) {
    return res.status(400).json({ error: "ID de campeonato inválido." });
  }
  try {
    const competitionsData = await footballData("/competitions", "competitions", COMPETITIONS_TTL_MS);
    const competitions = Array.isArray(competitionsData?.competitions) ? competitionsData.competitions : [];
    const competition = competitions.find(item => String(item.id) === id);
    if (!competition) {
      return res.status(404).json({ error: "Campeonato não disponível para esta conta." });
    }
    const code = competition.code || id;
    const data = await footballData(
      "/competitions/" + encodeURIComponent(code) + "/standings",
      "standings:" + code,
      60 * 60 * 1000
    );
    return res.json({
      provider: "football-data.org",
      campeonato_id: competition.id,
      campeonato: competition.name,
      standings: Array.isArray(data?.standings) ? data.standings : [],
      temporada: data?.season || competition.currentSeason || null
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// Resultados concluídos nos últimos sete dias, para a competição escolhida.
app.get("/api/campeonatos/:campeonatoId/resultados", async (req, res) => {
  const id = String(req.params.campeonatoId || "");
  if (!/^\\d+$/.test(id)) {
    return res.status(400).json({ error: "ID de campeonato inválido." });
  }
  const hoje = dataHojeBrasil();
  const [year, month, day] = hoje.split("-").map(Number);
  const inicio = new Date(Date.UTC(year, month - 1, day + 12));
  inicio.setUTCDate(inicio.getUTCDate() - 7);
  const dataInicial = inicio.toISOString().slice(0, 10);
  try {
    const competitionsData = await footballData("/competitions", "competitions", COMPETITIONS_TTL_MS);
    const competitions = Array.isArray(competitionsData?.competitions) ? competitionsData.competitions : [];
    const competition = competitions.find(item => String(item.id) === id);
    if (!competition) {
      return res.status(404).json({ error: "Campeonato não disponível para esta conta." });
    }
    const code = competition.code || id;
    const data = await footballData(
      "/competitions/" + encodeURIComponent(code) + "/matches?dateFrom=" + dataInicial + "&dateTo=" + hoje,
      "results:" + code + ":" + dataInicial + ":" + hoje,
      CACHE_TTL_MS
    );
    const partidas = (Array.isArray(data?.matches) ? data.matches : [])
      .filter(match => ["FINISHED", "AWARDED"].includes(match.status))
      .map(match => ({
        id: match.id,
        data_hora_realizacao: match.utcDate || null,
        status: match.status,
        time_mandante: { nome: match.homeTeam?.name || "A definir" },
        time_visitante: { nome: match.awayTeam?.name || "A definir" },
        placar_mandante: match.score?.fullTime?.home ?? null,
        placar_visitante: match.score?.fullTime?.away ?? null,
        campeonato: competition.name,
        rodada: match.matchday ?? null
      }));
    return res.json({
      provider: "football-data.org",
      campeonato_id: competition.id,
      campeonato: competition.name,
      data_inicial: dataInicial,
      data_final: hoje,
      total: partidas.length,
      partidas
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// Compatibilidade: fases pertenciam ao provedor anterior.
app.get("/api/campeonatos/:campeonatoId/fases", (_req, res) => {
  res.status(410).json({
    error: "A football-data.org não usa a rota de fases do provedor anterior. Use /api/campeonatos/:campeonatoId/jogos-hoje.",
    provider: "football-data.org"
  });
});
app.get("/api/campeonatos/:campeonatoId/fases/:faseId", (_req, res) => {
  res.status(410).json({
    error: "A football-data.org não usa a rota de fases do provedor anterior.",
    provider: "football-data.org"
  });
});

app.listen(PORT, () => {
  console.log("Green da Sorte API ouvindo na porta " + PORT);
});
