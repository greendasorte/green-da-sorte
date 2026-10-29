const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://api.api-futebol.com.br/v1";
const API_KEY = process.env.API_FUTEBOL_KEY;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";

app.use(cors({
  origin: [
    "https://greendasorte.github.io",
    "https://green-da-sorte.onrender.com",
    "https://green-da-sorte-2.onrender.com"
  ]
}));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    name: "Green da Sorte API",
    status: "online",
    provider: "Football-Data.org",
    keyConfigured: Boolean(FOOTBALL_DATA_TOKEN)
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    provider: "Football-Data.org",
    configured: Boolean(FOOTBALL_DATA_TOKEN),
    checkedAt: new Date().toISOString()
  });
});

async function apiFutebol(path, res) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "API_FUTEBOL_KEY não configurada no Render.",
      provider: "API Futebol"
    });
  }

  try {
    const response = await fetch(API_BASE + path, {
      headers: {
        Authorization: "Bearer " + API_KEY,
        Accept: "application/json"
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
      return res.status(response.status).json({
        error: "A API Futebol retornou um erro.",
        providerStatus: response.status,
        details: data
      });
    }

    return res.json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Não foi possível consultar a API Futebol.",
      details: error.name === "TimeoutError" ? "Tempo limite excedido." : error.message
    });
  }
}



// Football-Data.org proxy: matches scheduled for a date.
async function footballData(path, res) {
  if (!FOOTBALL_DATA_TOKEN) {
    return res.status(503).json({
      error: "FOOTBALL_DATA_TOKEN não configurado no Render.",
      provider: "Football-Data.org"
    });
  }
  try {
    const response = await fetch(FOOTBALL_DATA_BASE + path, {
      headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const bodyText = await response.text();
    let data;
    try { data = bodyText ? JSON.parse(bodyText) : {}; }
    catch { data = { message: bodyText }; }
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Football-Data.org retornou um erro.",
        providerStatus: response.status,
        details: data
      });
    }
    return res.json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Não foi possível consultar Football-Data.org.",
      details: error.name === "TimeoutError" ? "Tempo limite excedido." : error.message
    });
  }
}


app.get("/api/football-data/competitions", (_req, res) => {
  return footballData("/competitions", res);
});

app.get("/api/football-data/matches", (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Informe date no formato YYYY-MM-DD." });
  }
  return footballData("/matches?dateFrom=" + encodeURIComponent(date) + "&dateTo=" + encodeURIComponent(date), res);
});

app.get("/api/football-data/teams/:teamId/matches", (req, res) => {
  const { teamId } = req.params;
  if (!/^\d+$/.test(teamId)) {
    return res.status(400).json({ error: "ID de equipe inválido." });
  }
  return footballData("/teams/" + teamId + "/matches?status=FINISHED&limit=5", res);
});

// Legacy SofaScore endpoint retained temporarily for compatibility.
app.get("/api/times/:teamId/ultimos-jogos", async (req, res) => {
  const { teamId } = req.params;
  if (!/^\d+$/.test(teamId)) {
    return res.status(400).json({ error: "ID de equipe inválido." });
  }

  try {
    const response = await fetch(
      "https://www.sofascore.com/api/v1/team/" + teamId + "/events/last/0",
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) }
    );
    if (!response.ok) {
      return res.status(502).json({
        error: "Não foi possível consultar os últimos jogos da equipe.",
        providerStatus: response.status
      });
    }
    const data = await response.json();
    return res.json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Falha ao consultar os últimos jogos da equipe.",
      details: error.name === "TimeoutError" ? "Tempo limite excedido." : error.message
    });
  }
});

// Lista campeonatos disponíveis na conta/plano da API.
app.get("/api/campeonatos", (_req, res) => apiFutebol("/campeonatos", res));


 // Lista as fases de um campeonato.
app.get("/api/campeonatos/:campeonatoId/fases", (req, res) => {
  const { campeonatoId } = req.params;

  if (!/^\d+$/.test(campeonatoId)) {
    return res.status(400).json({
      error: "ID de campeonato inválido."
    });
  }

  return apiFutebol(
    "/campeonatos/" + campeonatoId + "/fases",
    res
  );
});

// Consulta uma fase específica.
app.get("/api/campeonatos/:campeonatoId/fases/:faseId", (req, res) => {
  const { campeonatoId, faseId } = req.params;

  if (!/^\d+$/.test(campeonatoId) || !/^\d+$/.test(faseId)) {
    return res.status(400).json({
      error: "ID de campeonato ou fase inválido."
    });
  }

  console.log("FASE SOLICITADA:", campeonatoId, faseId);

  return apiFutebol(
    "/campeonatos/" + campeonatoId + "/fases/" + faseId,
    res
  );
});

// Inicia o servidor.
app.listen(PORT, () => {
  console.log("Green da Sorte API ouvindo na porta " + PORT);
});
