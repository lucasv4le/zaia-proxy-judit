// api/judit/movimentacoes.js
// Serverless Function (Node.js) para Vercel
// GET /api/judit/movimentacoes?cnj=8030912-11.2022.8.05.0080&waitMs=60000

const REQUESTS_BASE = 'https://requests.prod.judit.io';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sendJson(res, obj, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(obj, null, 2));
}
function asBool(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'sim';
}

// Mapeia o objeto da JUDIT para nosso formato "sempre igual"
function buildZaiaPayload({ cnj, lawsuit, error, meta }) {
  const steps = Array.isArray(lawsuit?.steps) ? [...lawsuit.steps] : [];
  steps.sort((a, b) => new Date(b.step_date) - new Date(a.step_date));
  const last = steps[0] || null;

  const status = lawsuit?.status || (steps.length ? 'ANDAMENTO' : 'DESCONHECIDO');
  const tribunal = lawsuit?.tribunal_acronym || lawsuit?.response_data?.tribunal_acronym || null;
  const instanciaRaw = lawsuit?.instance || lawsuit?.response_data?.instance || null;
  const grauFmt =
    instanciaRaw === '1' || instanciaRaw === 1
      ? '1º grau'
      : instanciaRaw === '2' || instanciaRaw === 2
      ? '2º grau'
      : instanciaRaw || 'instância não informada';

  const payload = {
    ok: !error, // continua true em parcial (sem 'error')
    cnj,
    fonte: tribunal ? `${tribunal} - ${grauFmt}` : 'Fonte não informada',
    status,
    ultima_movimentacao_data: last?.step_date || null,
    texto: last?.content || null,
    ultima_movimentacao: last
      ? {
          id: last.step_id || null,
          data: last.step_date || null,
          tipo: 'ANDAMENTO',
          conteudo: last.content || null,
          private: !!last.private
        }
      : null,
    movimentacoes: steps.map((s) => ({
      id: s.step_id || null,
      data: s.step_date || null,
      tipo: 'ANDAMENTO',
      conteudo: s.content || null,
      private: !!s.private
    })),
    meta: {
      request_status: meta?.request_status || null, // 'completed' | 'pending' | etc.
      is_partial: !!meta?.is_partial,               // <— chave que a ZAIA vai usar
      cached_response: !!meta?.cached_response,
      waited_ms: meta?.waited_ms || 0,
      attempts: meta?.attempts || 0,
      message: meta?.message || undefined
    },
    erro: error
      ? {
          message: error.message || 'Erro desconhecido no proxy',
          detail: error.detail || null
        }
      : null
  };

  return payload;
}

// ---- JUDIT: chamadas base ----
async function createRequest({ apiKey, cnj, onDemand = false }) {
  const body = {
    search: {
      search_type: 'lawsuit_cnj',
      search_key: cnj,
      response_type: 'lawsuit',
      ...(onDemand ? { on_demand: true } : {})
    }
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

// ---- Handler principal ----
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cnj = (url.searchParams.get('cnj') || '').trim();

    // Controle de paciência principal
    const waitMs = Math.min(parseInt(url.searchParams.get('waitMs') || '30000', 10), 60000); // até 60s
    const pollInterval = Math.max(750, Math.min(parseInt(url.searchParams.get('pollMs') || '1500', 10), 5000));

    // (Opcional) Segunda tentativa curta antes de responder
    const retryOnPending = asBool(url.searchParams.get('retryOnPending') || '0');
    const graceMs = Math.min(parseInt(url.searchParams.get('graceMs') || '5000', 10), 15000); // até 15s
    const gracePollMs = Math.max(500, Math.min(parseInt(url.searchParams.get('gracePollMs') || '800', 10), 3000));

    // (Opcional) Forçar on-demand
    const forceOnDemand = asBool(url.searchParams.get('forceOnDemand') || '0');

    if (!cnj) {
      return sendJson(
        res,
        buildZaiaPayload({
          cnj: null,
          lawsuit: null,
          error: { message: 'Parâmetro "cnj" é obrigatório.' },
          meta: { waited_ms: 0, attempts: 0, is_partial: true }
        }),
        400
      );
    }

    const apiKey = process.env.JUDIT_API_KEY;
    if (!apiKey) {
      return sendJson(
        res,
        buildZaiaPayload({
          cnj,
          lawsuit: null,
          error: { message: 'JUDIT_API_KEY não configurada no ambiente.' },
          meta: { waited_ms: 0, attempts: 0, is_partial: true }
        }),
        500
      );
    }

    // 1) Cria a requisição
    const created = await createRequest({ apiKey, cnj, onDemand: forceOnDemand });
    const requestId = created?.request_id;
    if (!requestId) {
      return sendJson(
        res,
        buildZaiaPayload({
          cnj,
          lawsuit: null,
          error: { message: 'request_id não retornado pela JUDIT.', detail: created },
          meta: { waited_ms: 0, attempts: 1, is_partial: true }
        }),
        502
      );
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
          // Só sai do loop se estiver COMPLETED; se tiver só "page_data" mas ainda pendente, continua esperando
          if (requestStatus === 'completed' || completed?.request_status === 'completed') break;
        }
      } catch (_) {}

      await sleep(pollInterval);
    }

    // 2.1) Grace period opcional: uma 2ª tentativa curtinha se ainda estiver pendente
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

    const waited_ms = Date.now() - start;
    const isCompleted = completed && (requestStatus === 'completed' || completed?.request_status === 'completed');

    // 3) Decisão final
    if (isCompleted) {
      const lawsuit = completed?.response_data || null;
      return sendJson(
        res,
        buildZaiaPayload({
          cnj,
          lawsuit,
          error: null,
          meta: {
            request_status: 'completed',
            is_partial: false,
            cached_response: !!completed?.tags?.cached_response,
            waited_ms,
            attempts
          }
        }),
        200
      );
    }

    // Parcial: temos algum 'completed' (page_data) mas status ainda pendente — responde 202 com is_partial=true
    if (completed) {
      const lawsuit = completed?.response_data || null;
      return sendJson(
        res,
        buildZaiaPayload({
          cnj,
          lawsuit,
          error: null, // mantém ok: true para não quebrar fluxos
          meta: {
            request_status: requestStatus || completed?.request_status || 'pending',
            is_partial: true,
            cached_response: !!completed?.tags?.cached_response,
            waited_ms,
            attempts,
            message: 'Resposta parcial: a JUDIT ainda está finalizando.'
          }
        }),
        202
      );
    }

    // Sem dados dentro do tempo: responde 202 e deixa claro no meta
    return sendJson(
      res,
      buildZaiaPayload({
        cnj,
        lawsuit: null,
        error: {
          message: 'Não foi possível obter as movimentações dentro do tempo limite.',
          detail: { request_id: requestId, request_status: requestStatus }
        },
        meta: { request_status: requestStatus, is_partial: true, waited_ms, attempts }
      }),
      202
    );
  } catch (err) {
    return sendJson(
      res,
      buildZaiaPayload({
        cnj: null,
        lawsuit: null,
        error: { message: err?.message || 'Erro inesperado no proxy', detail: err?.detail || err },
        meta: { waited_ms: 0, attempts: 0, is_partial: true }
      }),
      500
    );
  }
}
