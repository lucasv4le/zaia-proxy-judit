// api/judit/movimentacoes.js
// Serverless Function (Node.js) para Vercel
// GET /api/judit/movimentacoes?cnj=8030912-11.2022.8.05.0080&waitMs=60000

const REQUESTS_BASE = 'https://requests.prod.judit.io';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sendJson(res, obj, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(obj, null, 2));
}
function asBool(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'sim';
}

// ————————————————————————————————————————————————————————————————
// Mapeia a resposta da JUDIT para o JSON ENXUTO solicitado
// Só devolvemos: cnj, fonte, status, processo.fase, ultima_movimentacao.conteudo, ultima_movimentacao_data
function buildMinimalPayload({ cnj, lawsuit }) {
  const rd = lawsuit?.response_data || lawsuit || {};

  // steps ordenados desc por data
  const steps = Array.isArray(lawsuit?.steps)
    ? [...lawsuit.steps]
    : Array.isArray(rd?.steps)
    ? [...rd.steps]
    : [];
  steps.sort((a, b) => new Date(b.step_date) - new Date(a.step_date));
  const last = steps[0] || null;

  // status e fonte (tribunal + grau)
  const status = rd?.status || (steps.length ? 'ANDAMENTO' : 'DESCONHECIDO');
  const tribunal = rd?.tribunal_acronym || lawsuit?.tribunal_acronym || null;
  const instanciaRaw = rd?.instance || lawsuit?.instance || null;
  const grauFmt =
    instanciaRaw === '1' || instanciaRaw === 1
      ? '1º grau'
      : instanciaRaw === '2' || instanciaRaw === 2
      ? '2º grau'
      : instanciaRaw || 'instância não informada';

  // fase do processo
  const fase = rd?.phase || null;

  // objeto final enxuto
  return {
    cnj: cnj || null,
    fonte: tribunal ? `${tribunal} - ${grauFmt}` : 'Fonte não informada',
    status: status || null,
    processo: { fase: fase },
    ultima_movimentacao: {
      conteudo: last?.content || null
    },
    ultima_movimentacao_data: last?.step_date || null
  };
}
// ————————————————————————————————————————————————————————————————

// JUDIT — chamadas base
async function createRequest({ apiKey, cnj, onDemand = false }) {
  const body = {
    search: {
      search_type: 'lawsuit_cnj',
      search_key: cnj,
      response_type: 'lawsuit'
    },
    ...(onDemand ? { on_demand: true } : {})
  };

  const res = await fetch(`${REQUESTS_BASE}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw { message: 'Falha ao criar requisição na JUDIT', detail: { status: res.status, text } };
  }
  return res.json();
}

async function getRequest({ apiKey, requestId }) {
  const res = await fetch(`${REQUESTS_BASE}/requests/${encodeURIComponent(requestId)}`, {
    headers: { 'api-key': apiKey }
  });
  if (!res.ok) {
    const text = await res.text();
    throw { message: 'Falha ao consultar request_id na JUDIT', detail: { status: res.status, text } };
  }
  return res.json();
}

async function getResponses({ apiKey, requestId, pageSize = 100 }) {
  const url = `${REQUESTS_BASE}/responses?page_size=${pageSize}&request_id=${encodeURIComponent(requestId)}`;
  const res = await fetch(url, { headers: { 'api-key': apiKey } });
  if (!res.ok) {
    const text = await res.text();
    throw { message: 'Falha ao listar responses na JUDIT', detail: { status: res.status, text } };
  }
  return res.json();
}

// Handler
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cnj = (url.searchParams.get('cnj') || '').trim();

    // Controle de paciência
    const waitMs = Math.min(parseInt(url.searchParams.get('waitMs') || '30000', 10), 60000);
    const pollInterval = Math.max(750, Math.min(parseInt(url.searchParams.get('pollMs') || '1500', 10), 5000));

    // (Opcional) 2ª tentativa curta antes de responder
    const retryOnPending = asBool(url.searchParams.get('retryOnPending') || '0');
    const graceMs = Math.min(parseInt(url.searchParams.get('graceMs') || '5000', 10), 15000);
    const gracePollMs = Math.max(500, Math.min(parseInt(url.searchParams.get('gracePollMs') || '800', 10), 3000));

    // (Opcional) Forçar on-demand
    const forceOnDemand = asBool(url.searchParams.get('forceOnDemand') || '0');

    if (!cnj) {
      // Mesmo sem CNJ, devolvemos as chaves pedidas com nulls
      return sendJson(res, {
        cnj: null,
        fonte: 'Fonte não informada',
        status: null,
        processo: { fase: null },
        ultima_movimentacao: { conteudo: null },
        ultima_movimentacao_data: null
      }, 400);
    }

    const apiKey = process.env.JUDIT_API_KEY;
    if (!apiKey) {
      return sendJson(res, {
        cnj,
        fonte: 'Fonte não informada',
        status: null,
        processo: { fase: null },
        ultima_movimentacao: { conteudo: null },
        ultima_movimentacao_data: null
      }, 500);
    }

    // 1) Cria a requisição
    const created = await createRequest({ apiKey, cnj, onDemand: forceOnDemand });
    const requestId = created?.request_id;
    if (!requestId) {
      return sendJson(res, {
        cnj,
        fonte: 'Fonte não informada',
        status: null,
        processo: { fase: null },
        ultima_movimentacao: { conteudo: null },
        ultima_movimentacao_data: null
      }, 502);
    }

    // 2) Polling até completar ou estourar timeout
    const start = Date.now();
    let attempts = 0;
    let completed = null;
    let requestStatus = 'pending';

    while (Date.now() - start < waitMs) {
      attempts += 1;

      try {
        const r = await getRequest({ apiKey, requestId });
        requestStatus = r?.status || requestStatus;
      } catch (_) {}

      try {
        const resp = await getResponses({ apiKey, requestId });
        if (Array.isArray(resp?.page_data) && resp.page_data.length) {
          completed = resp.page_data[0];
          requestStatus = resp?.request_status || requestStatus;
          if (requestStatus === 'completed' || completed?.request_status === 'completed') break;
        }
      } catch (_) {}

      await sleep(pollInterval);
    }

    // 2.1) Grace period opcional
    if (retryOnPending && !(requestStatus === 'completed' || completed?.request_status === 'completed')) {
      const graceStart = Date.now();
      while (Date.now() - graceStart < graceMs) {
        try {
          const resp2 = await getResponses({ apiKey, requestId });
          if (Array.isArray(resp2?.page_data) && resp2.page_data.length) {
            completed = resp2.page_data[0];
            requestStatus = resp2?.request_status || requestStatus;
            if (requestStatus === 'completed' || completed?.request_status === 'completed') break;
          }
        } catch (_) {}
        await sleep(gracePollMs);
      }
    }

    const isCompleted =
      completed && (requestStatus === 'completed' || completed?.request_status === 'completed');

    // 3) Decisão final — sempre com JSON minimalista
    if (isCompleted) {
      const lawsuit = completed?.response_data || completed || null;
      return sendJson(res, buildMinimalPayload({ cnj, lawsuit }), 200);
    }

    if (completed) {
      const lawsuit = completed?.response_data || completed || null;
      // parcial (202), mas mesmo JSON enxuto
      return sendJson(res, buildMinimalPayload({ cnj, lawsuit }), 202);
    }

    // Sem dados dentro do tempo — mantém chaves com null
    return sendJson(res, {
      cnj,
      fonte: 'Fonte não informada',
      status: null,
      processo: { fase: null },
      ultima_movimentacao: { conteudo: null },
      ultima_movimentacao_data: null
    }, 202);

  } catch (err) {
    // Falha inesperada — mantém chaves com null
    return sendJson(res, {
      cnj: null,
      fonte: 'Fonte não informada',
      status: null,
      processo: { fase: null },
      ultima_movimentacao: { conteudo: null },
      ultima_movimentacao_data: null
    }, 500);
  }
}
