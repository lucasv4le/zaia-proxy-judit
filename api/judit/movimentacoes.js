// api/judit/movimentacoes.js
// Serverless Function (Node.js) para Vercel
// GET /api/judit/movimentacoes?cnj=8030912-11.2022.8.05.0080&waitMs=60000

const REQUESTS_BASE = 'https://requests.prod.judit.io';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sendJson(res, obj, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(obj, null, 2));
}

// Mapeia o objeto da JUDIT para nosso formato "sempre igual"
function buildZaiaPayload({ cnj, lawsuit, error, meta }) {
  const steps = Array.isArray(lawsuit?.steps) ? lawsuit.steps : [];
  steps.sort((a, b) => new Date(b.step_date) - new Date(a.step_date));
  const last = steps[0] || null;

  const status = lawsuit?.status || (steps.length ? 'ANDAMENTO' : 'DESCONHECIDO');
  const tribunal = lawsuit?.tribunal_acronym || lawsuit?.response_data?.tribunal_acronym || null;
  const instancia = lawsuit?.instance || lawsuit?.response_data?.instance || null;

  const payload = {
    ok: !error,
    cnj,
    fonte: tribunal ? `${tribunal} - ${instancia || 'instância não informada'}` : 'Fonte não informada',
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
    movimentacoes: steps.map(s => ({
      id: s.step_id || null,
      data: s.step_date || null,
      tipo: 'ANDAMENTO',
      conteudo: s.content || null,
      private: !!s.private
    })),
    meta: {
      request_status: meta?.request_status || null,
      cached_response: !!meta?.cached_response,
      waited_ms: meta?.waited_ms || 0,
      attempts: meta?.attempts || 0
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

async function createRequest({ apiKey, cnj }) {
  const body = {
    search: {
      search_type: 'lawsuit_cnj',
      search_key: cnj,
      response_type: 'lawsuit'
    }
  };

  const res = await fetch(`${REQUESTS_BASE}/requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw {
      message: 'Falha ao criar requisição na JUDIT',
      detail: { status: res.status, text }
    };
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
  const res = await fetch(url, {
    headers: { 'api-key': apiKey }
  });
  if (!res.ok) {
    const text = await res.text();
    throw { message: 'Falha ao listar responses na JUDIT', detail: { status: res.status, text } };
  }
  return res.json();
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cnj = (url.searchParams.get('cnj') || '').trim();
    const waitMs = Math.min(parseInt(url.searchParams.get('waitMs') || '30000', 10), 60000); // até 60s
    const pollInterval = Math.max(750, Math.min(parseInt(url.searchParams.get('pollMs') || '1500', 10), 5000));

    if (!cnj) {
      return sendJson(res,
        buildZaiaPayload({
          cnj: null,
          lawsuit: null,
          error: { message: 'Parâmetro \"cnj\" é obrigatório.' },
          meta: { waited_ms: 0, attempts: 0 }
        }),
        400
      );
    }

    const apiKey = process.env.JUDIT_API_KEY;
    if (!apiKey) {
      return sendJson(res,
        buildZaiaPayload({
          cnj,
          lawsuit: null,
          error: { message: 'JUDIT_API_KEY não configurada no ambiente.' },
          meta: { waited_ms: 0, attempts: 0 }
        }),
        500
      );
    }

    // 1) Cria a requisição
    const created = await createRequest({ apiKey, cnj });
    const requestId = created?.request_id;

    if (!requestId) {
      return sendJson(res,
        buildZaiaPayload({
          cnj,
          lawsuit: null,
          error: { message: 'request_id não retornado pela JUDIT.', detail: created },
          meta: { waited_ms: 0, attempts: 1 }
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
          break;
        }
      } catch (_) {}

      await sleep(pollInterval);
    }

    const waited_ms = Date.now() - start;

    if (completed) {
      const lawsuit = completed?.response_data || null;
      return sendJson(res,
        buildZaiaPayload({
          cnj,
          lawsuit,
          error: null,
          meta: {
            request_status: requestStatus || 'completed',
            cached_response: !!completed?.tags?.cached_response,
            waited_ms,
            attempts
          }
        }),
        200
      );
    }

    return sendJson(res,
      buildZaiaPayload({
        cnj,
        lawsuit: null,
        error: {
          message: 'Não foi possível obter as movimentações dentro do tempo limite.',
          detail: { request_id: requestId, request_status: requestStatus }
        },
        meta: { request_status: requestStatus, waited_ms, attempts }
      }),
      202
    );
  } catch (err) {
    return sendJson(res,
      buildZaiaPayload({
        cnj: null,
        lawsuit: null,
        error: { message: err?.message || 'Erro inesperado no proxy', detail: err?.detail || err },
        meta: { waited_ms: 0, attempts: 0 }
      }),
      500
    );
  }
}
