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

// Diagnóstico: compara a fase atual informada no campeonato com a lista de fases
// e confirma se a API devolve o mesmo ID ao consultar a fase atual.
app.get("/api/diagnostico/campeonatos/:campeonatoId", async (req, res) => {
  const { campeonatoId } = req.params;

  if (!/^\\d+$/.test(campeonatoId)) {
    return res.status(400).json({ error: "ID de campeonato inválido." });
  }
  if (!API_KEY) {
    return res.status(503).json({
      error: "API_FUTEBOL_KEY não configurada no Render.",
      provider: "API Futebol"
    });
  }

  try {
    const campeonatosResposta = await buscarDadosFutebol("/campeonatos");
    const campeonatos = Array.isArray(campeonatosResposta)
      ? campeonatosResposta
      : Array.isArray(campeonatosResposta?.data)
        ? campeonatosResposta.data
        : Array.isArray(campeonatosResposta?.campeonatos)
          ? campeonatosResposta.campeonatos
          : [];
    const campeonato = campeonatos.find(item =>
      String(item.campeonato_id ?? item.id) === String(campeonatoId)
    );

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

    const faseAtual = campeonato?.fase_atual ?? null;
    const faseAtualId = faseAtual?.fase_id ?? faseAtual?.id ?? null;
    let detalheConsultado = null;
    let erroDetalhe = null;

    if (faseAtualId != null) {
      try {
        const detalhe = await buscarDadosFutebol(
          "/campeonatos/" + campeonatoId + "/fases/" + faseAtualId
        );
        detalheConsultado = {
          fase_id_solicitada: Number(faseAtualId),
          fase_id_retornada: detalhe?.fase_id ?? detalhe?.id ?? null,
          nome: detalhe?.nome ?? detalhe?.nome_popular ?? null,
          total_partidas: Array.isArray(detalhe?.partidas)
            ? detalhe.partidas.length
            : null,
          ids_conferem:
            (detalhe?.fase_id ?? detalhe?.id) == null
              ? null
              : String(detalhe.fase_id ?? detalhe.id) === String(faseAtualId)
        };
      } catch (error) {
        erroDetalhe = {
          status: error.status ?? null,
          mensagem: error.message,
          detalhes: error.details ?? null
        };
      }
    }

    return res.json({
      campeonato_id: Number(campeonatoId),
      campeonato_encontrado: Boolean(campeonato),
      campeonato: campeonato ? {
        nome: campeonato.nome_popular ?? campeonato.nome ?? null,
        status: campeonato.status ?? null,
        edicao_atual: campeonato.edicao_atual ?? null,
        fase_atual: faseAtual ? {
          fase_id: faseAtualId,
          nome: faseAtual.nome ?? faseAtual.nome_popular ?? null,
          status: faseAtual.status ?? null
        } : null
      } : null,
      fases_listadas: fases.map(fase => ({
        fase_id: fase.fase_id ?? fase.id ?? null,
        nome: fase.nome ?? fase.nome_popular ?? null,
        status: fase.status ?? null
      })),
      detalhe_fase_atual: detalheConsultado,
      erro_detalhe_fase_atual: erroDetalhe,
      consultado_em: new Date().toISOString()
    });
  } catch (error) {
    console.error("ERRO DIAGNÓSTICO CAMPEONATO:", error.message);
    return res.status(error.status || 502).json({
      error: "Não foi possível diagnosticar o campeonato.",
      provider: "API Futebol",
      details: error.details || error.message
    });
  }
});

// Busca jogos de hoje usando a fase_atual do campeonato.
// Se a API devolver uma fase diferente da solicitada, bloqueia os dados para não
// exibir partidas antigas como se fossem jogos de hoje.
app.get("/api/campeonatos/:campeonatoId/jogos-hoje", async (req, res) => {
  const { campeonatoId } = req.params;

  if (!/^\\d+$/.test(campeonatoId)) {
    return res.status(400).json({ error: "ID de campeonato inválido." });
  }
  if (!API_KEY) {
    return res.status(503).json({
      error: "API_FUTEBOL_KEY não configurada no Render.",
      provider: "API Futebol"
    });
  }

  const hoje = dataHojeBrasil();

  try {
    const campeonatosResposta = await buscarDadosFutebol("/campeonatos");
    const campeonatos = Array.isArray(campeonatosResposta)
      ? campeonatosResposta
      : Array.isArray(campeonatosResposta?.data)
        ? campeonatosResposta.data
        : Array.isArray(campeonatosResposta?.campeonatos)
          ? campeonatosResposta.campeonatos
          : [];
    const campeonato = campeonatos.find(item =>
      String(item.campeonato_id ?? item.id) === String(campeonatoId)
    );

    if (!campeonato) {
      return res.status(404).json({
        error: "Campeonato não encontrado na lista retornada pela API Futebol.",
        campeonato_id: Number(campeonatoId),
        data: hoje,
        total: 0,
        partidas: []
      });
    }

    const faseAtual = campeonato.fase_atual ?? null;
    const faseId = faseAtual?.fase_id ?? faseAtual?.id ?? null;

    if (faseId == null) {
      return res.status(502).json({
        error: "A API não informou a fase atual deste campeonato.",
        campeonato_id: Number(campeonatoId),
        campeonato: campeonato.nome_popular ?? campeonato.nome ?? null,
        data: hoje,
        total: 0,
        partidas: [],
        proximo_passo: "Verificar no painel/documentação da API Futebol qual edição e fase estão disponíveis para este campeonato."
      });
    }

    const faseDetalhe = await buscarDadosFutebol(
      "/campeonatos/" + campeonatoId + "/fases/" + faseId
    );
    const faseDetalheId = faseDetalhe?.fase_id ?? faseDetalhe?.id ?? null;

    if (faseDetalheId != null && String(faseDetalheId) !== String(faseId)) {
      console.error(
        "FASE INCONSISTENTE:",
        "solicitada", faseId,
        "retornada", faseDetalheId,
        "campeonato", campeonatoId
      );
      return res.status(502).json({
        error: "A API Futebol retornou uma fase diferente da solicitada. As partidas foram bloqueadas para evitar dados antigos.",
        campeonato_id: Number(campeonatoId),
        campeonato: campeonato.nome_popular ?? campeonato.nome ?? null,
        data: hoje,
        fase_id_solicitada: Number(faseId),
        fase_id_retornada: Number(faseDetalheId),
        total: 0,
        partidas: [],
        proximo_passo: "Abra /api/diagnostico/campeonatos/" + campeonatoId + " e envie o JSON completo para identificar a inconsistência."
      });
    }

    const partidas = extrairPartidasDoDia(faseDetalhe, hoje);
    return res.json({
      campeonato_id: Number(campeonatoId),
      campeonato: campeonato.nome_popular ?? campeonato.nome ?? null,
      edicao_atual: campeonato.edicao_atual ?? null,
      fase_id: Number(faseId),
      fase: faseAtual.nome ?? faseAtual.nome_popular ?? null,
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
