const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://api.api-futebol.com.br/v1";
const API_KEY = process.env.API_FUTEBOL_KEY;

app.use(cors({
  origin: [
    "https://greendasorte.github.io",
    "https://green-da-sorte.onrender.com"
  ]
}));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    name: "Green da Sorte API",
    status: "online",
    provider: "API Futebol",
    keyConfigured: Boolean(API_KEY)
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    provider: "API Futebol",
    configured: Boolean(API_KEY),
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

// Lista campeonatos disponíveis na conta/plano da API.
app.get("/api/campeonatos", (_req, res) => apiFutebol("/campeonatos", res));

// Lista as fases de um campeonato.
app.get("/api/campeonatos/:campeonatoId/fases", (req, res) => {
  const { campeonatoId } = req.params;
  if (!/^\d+$/.test(campeonatoId)) {
    return res.status(400).json({ error: "ID de campeonato inválido." });
  }
  return apiFutebol("/campeonatos/" + campeonatoId + "/fases", res);
});

// Consulta uma fase específica, incluindo os dados de partidas fornecidos pela API.
app.get("/api/campeonatos/:campeonatoId/fases/:faseId", (req, res) => {
  const { campeonatoId, faseId } = req.params;
  if (!/^\d+$/.test(campeonatoId) || !/^\d+$/.test(faseId)) {
    return res.status(400).json({ error: "ID de campeonato ou fase inválido." });
  }
  return apiFutebol("/campeonatos/" + campeonatoId + "/fases/" + faseId, res);
});

app.listen(PORT, () => {
  console.log("Green da Sorte API ouvindo na porta " + PORT);
});
