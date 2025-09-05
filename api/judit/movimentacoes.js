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

// --- Mapeia o objeto da JUDIT para nosso formato "sempre igual" ---
// agora com opção includeAttachments (default: false)
function buildZaiaPayload({ cnj, lawsuit, error, meta }, { includeAttachments = false } = {}) {
  const rd = lawsuit?.response_data || lawsuit || {};

  // Steps (movimentações)
  const steps = Array.isArray(lawsuit?.steps)
    ? [...lawsuit.steps]
    : Array.isArray(rd?.steps)
    ? [...rd.steps]
    : [];
  steps.sort((a, b) => new Date(b.step_date) - new Date(a.step_date));
  const last = steps[0] || null;

  // Status/capa/localização
  const status = rd?.status || (steps.length ? 'ANDAMENTO' : 'DESCONHECIDO');
  const tribunal = rd?.tribunal_acronym || lawsuit?.tribunal_acronym || null;
  const instanciaRaw = rd?.instance || lawsuit?.instance || null;
  const grauFmt =
    instanciaRaw === '1' || instanciaRaw === 1
      ? '1º grau'
      : instanciaRaw === '2' || instanciaRaw === 2
      ? '2º grau'
      : instanciaRaw || 'instância não informada';

  // Partes (com advogados)
  const partiesArr = Array.isArray(rd?.parties)
    ? rd.parties
    : Array.isArray(lawsuit?.parties)
    ? lawsuit.parties
    : [];
  const partes = partiesArr.map((p) => ({
    nome: p?.name || null,
    polo: p?.side || null,
    tipo: p?.person_type || null,
    documento: p?.main_document || null,
    documentos: Array.isArray(p?.documents)
      ? p.documents.map((d) => (typeof d === 'string' ? d : d?.document || null)).filter(Boolean)
      : [],
    advogados: Array.isArray(p?.lawyers)
      ? p.lawyers.map((l) => ({
          nome: l?.name || null,
          oab:
            l?.oab ||
            (Array.isArray(l?.documents)
              ? (l.documents.find((doc) =>
                  String(doc?.document_type || '').toLowerCase().includes('oab')
                )?.document || null)
              : null)
        }))
      : []
  }));

  // Processo (capa + localização + metadados)
  const processo = {
    codigo: rd?.code || cnj || null,
    classe: Array.isArray(rd?.classifications)
      ? rd.classifications.map((c) => c?.name || c).filter(Boolean)
      : rd?.classifications || null,
    assuntos: Array.isArray(rd?.subjects)
      ? rd.subjects.map((s) => s?.name || s).filter(Boolean)
      : rd?.subjects || null,
    orgao: (Array.isArray(rd?.courts) && rd.courts[0]?.name) || rd?.court || null,
    juiz: rd?.judge || null,
    tipo_justica: rd?.justice_description || null,
    instancia: instanciaRaw || null,
    comarca: rd?.county || null,
    cidade: rd?.city || null,
    uf: rd?.state || null,
    tribunal: tribunal || null,
    fase: rd?.phase || null,
    situacao: rd?.situation || null,
    distribuicao: rd?.distribution_date || null,
    valor_causa: rd?.amount || null,
    sigilo: (rd?.secrecy_level ?? null)
  };

  // Anexos (apenas se includeAttachments === true)
  const attachmentsArr = includeAttachments && Array.isArray(rd?.attachments) ? rd.attachments : [];
  const anexosMapped = attachmentsArr.map((a) => ({
    id: a?.attachment_id || null,
    data: a?.attachment_date || null,
    nome: a?.attachment_name || null,
    extensao: a?.extension || null,
    status: a?.status || null
  }));

  const payload = {
    ok: !error, // continua true em parcial
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
    processo,
    partes,
    anexos: includeAttachments ? anexosMapped : [], // <-- por padrão volta [], só preenche quando solicitado
    meta: {
      request_status: meta?.request_status || null,
      is_partial: !!meta?.is_partial,
      cached_response: !!meta?.cached_response,
      waited_ms: meta?.waited_ms || 0,
      attempts: meta?.attempts || 0,
      message: meta?.message || undefined
    },
    erro: error
      ? { message: error.message || 'Erro desconhecido no proxy', detail: error.detail || null }
      : null
  };
  return payload;
}

// ---- Chamadas JUDIT ----
async function createRequest({ apiKey, cnj, onDemand = false, withAttachments = false }) {
  const body = {
    search: {
      search_type: 'lawsuit_cnj',
      search_key: cnj,
      response_type: 'lawsuit'
    },
    ...(onDemand ? { on_demand: true } : {}),
    ...(withAttachments ? { with_attachments: true } : {}) // só pede anexos se você mandar withAttachments=1
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

// ---- Handler ----
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cnj = (url.searchParams.get('cnj') || '').trim();

    const waitMs = Math.min(parseInt(url.searchParams.get('waitMs') || '30000', 10), 60000);
    const pollInterval = Math.max(750, Math.min(parseInt(url.searchParams.get('pollMs') || '1500', 10), 5000));

    // Anexos: desabilitados por padrão
    const withAttachments = asBool(url.searchParams.get('withAttachments') || '0'); // pede anexos na JUDIT
    const includeAttachments = asBool(url.searchParams.get('includeAttachments') || '0'); // inclui anexos no JSON do proxy

    // (Opcional) 2ª tentativa curta antes de responder
    const retryOnPending = asBool(url.searchParams.get('retryOnPending') || '0');
    const graceMs = Math.min(parseInt(url.searchParams.get('graceMs') || '5000', 10), 15000);
    const gracePollMs = Math.max(500, Math.min(parseInt(url.searchParams.get('gracePollMs') || '800', 10), 3000));

    // (Opcional) Forçar on-demand
    const forceOnDemand = asBool(url.searchParams.get('forceOnDemand') || '0');

    if (!cnj) {
      return sendJson(
        res,
        buildZaiaPayload(
          {
            cnj: null,
            lawsuit: null,
            error: { message: 'Parâmetro "cnj" é obrigatório.' },
            meta: { waited_ms: 0, attempts: 0, is_partial: true }
          },
          { includeAttachments }
        ),
        400
      );
    }

    const apiKey = process.env.JUDIT_API_KEY;
    if (!apiKey) {
      return sendJson(
        res,
        buildZaiaPayload(
          {
            cnj,
            lawsuit: null,
            error: { message: 'JUDIT_API_KEY não configurada no ambiente.' },
            meta: { waited_ms: 0, attempts: 0, is_partial: true }
          },
          { includeAttachments }
        ),
        500
      );
    }

    // 1) Cria a requisição
    const created = await createRequest({
      apiKey,
      cnj,
      onDemand: forceOnDemand,
      withAttachments // só envia true se você pedir
    });
    const requestId = created?.request_id;
    if (!requestId) {
      return sendJson(
        res,
        buildZaiaPayload(
          {
            cnj,
            lawsuit: null,
            error: { message: 'request_id não retornado pela JUDIT.', detail: created },
            meta: { waited_ms: 0, attempts: 1, is_partial: true }
          },
          { includeAttachments }
        ),
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

    const waited_ms = Date.now() - start;
    const isCompleted =
      completed && (requestStatus === 'completed' || completed?.request_status === 'completed');

    // 3) Decisão final (200 completo / 202 parcial)
    if (isCompleted) {
      const lawsuit = completed?.response_data || completed || null;
      return sendJson(
        res,
        buildZaiaPayload(
          {
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
          },
          { includeAttachments }
        ),
        200
      );
    }

    if (completed) {
      const lawsuit = completed?.response_data || completed || null;
      return sendJson(
        res,
        buildZaiaPayload(
          {
            cnj,
            lawsuit,
            error: null,
            meta: {
              request_status: requestStatus || completed?.request_status || 'pending',
              is_partial: true,
              cached_response: !!completed?.tags?.cached_response,
              waited_ms,
              attempts,
              message: 'Resposta parcial: a JUDIT ainda está finalizando.'
            }
          },
          { includeAttachments }
        ),
        202
      );
    }

    // Sem dados no tempo
    return sendJson(
      res,
      buildZaiaPayload(
        {
          cnj,
          lawsuit: null,
          error: {
            message: 'Não foi possível obter as movimentações dentro do tempo limite.',
            detail: { request_id: requestId, request_status: requestStatus }
          },
          meta: { request_status: requestStatus, is_partial: true, waited_ms, attempts }
        },
        { includeAttachments }
      ),
      202
    );
  } catch (err) {
    return sendJson(
      res,
      buildZaiaPayload(
        {
          cnj: null,
          lawsuit: null,
          error: { message: err?.message || 'Erro inesperado no proxy', detail: err?.detail || err },
          meta: { waited_ms: 0, attempts: 0, is_partial: true }
        },
        { includeAttachments: false }
      ),
      500
    );
  }
}
