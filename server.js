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

// Utilitário interno para consultar a API sem responder antes de montar o resultado.
async function buscarDadosFutebol(path) {
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
    const error = new Error("A API Futebol retornou um erro.");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
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

function dataPartidaISO(value) {
  if (typeof value !== "string") return null;

  const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate && value.length === 10) return isoDate[1];

  const brDate = value.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brDate) return brDate[3] + "-" + brDate[2] + "-" + brDate[1];

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function extrairPartidasDoDia(data, dataAlvo) {
  const partidas = [];
  const visitados = new Set();
  const camposData = [
    "data_realizacao",
    "data_hora_realizacao",
    "data_partida",
    "match_date",
    "data",
    "date"
  ];

  function percorrer(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      value.forEach(percorrer);
      return;
    }

    const id = value.partida_id ?? value.match_id ?? value.id;
    const dataValor = camposData.map(campo => value[campo]).find(v => typeof v === "string");
    const dataISO = dataPartidaISO(dataValor);
    const temDadosDePartida =
      value.partida_id != null ||
      value.match_id != null ||
      (value.time_mandante != null && value.time_visitante != null) ||
      (value.mandante != null && value.visitante != null) ||
      (value.homeTeam != null && value.awayTeam != null);

    if (id != null && dataISO === dataAlvo && temDadosDePartida) {
      const chave = String(id) + ":" + dataISO;
      if (!visitados.has(chave)) {
        visitados.add(chave);
        partidas.push(value);
      }
    }

    Object.values(value).forEach(percorrer);
  }

  percorrer(data);
  return partidas;
}

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

// Busca automaticamente as partidas de hoje dentro de todas as fases do campeonato.
app.get("/api/campeonatos/:campeonatoId/jogos-hoje", async (req, res) => {
  const { campeonatoId } = req.params;

  if (!/^\d+$/.test(campeonatoId)) {
    return res.status(400).json({
      error: "ID de campeonato inválido."
    });
  }

  if (!API_KEY) {
    return res.status(503).json({
      error: "API_FUTEBOL_KEY não configurada no Render.",
      provider: "API Futebol"
    });
  }

  const hoje = dataHojeBrasil();

  try {
    const fasesResposta = await buscarDadosFutebol(
      "/campeonatos/" + campeonatoId + "/fases"
    );

    const fases = Array.isArray(fasesResposta)
      ? fasesResposta
      : Array.isArray(fasesResposta?.data)
        ? fasesResposta.data
        : Array.isArray(fasesResposta?.fases)
          ? fasesResposta.fases
          : [];

    if (!fases.length) {
      return res.json({
        campeonato_id: Number(campeonatoId),
        data: hoje,
        total: 0,
        partidas: [],
        aviso: "A API não retornou fases para este campeonato."
      });
    }

    const partidas = [];
    for (const fase of fases) {
      const faseId = fase.fase_id ?? fase.id;
      if (faseId == null) continue;

      const faseDetalhe = await buscarDadosFutebol(
        "/campeonatos/" + campeonatoId + "/fases/" + faseId
      );
      const partidasFase = extrairPartidasDoDia(faseDetalhe, hoje);

      for (const partida of partidasFase) {
        partidas.push({
          ...partida,
          fase_id_consultada: faseId
        });
      }
    }

    return res.json({
      campeonato_id: Number(campeonatoId),
      data: hoje,
      total: partidas.length,
      partidas
    });
  } catch (error) {
    console.error("ERRO JOGOS DO DIA:", error.message);
    return res.status(error.status || 502).json({
      error: "Não foi possível buscar os jogos de hoje deste campeonato.",
      provider: "API Futebol",
      details: error.details || error.message
    });
  }
});

// Inicia o servidor.
app.listen(PORT, () => {
  console.log("Green da Sorte API ouvindo na porta " + PORT);
});
