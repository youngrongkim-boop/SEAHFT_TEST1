// Gemini 프록시 (Vercel 서버리스 함수)
//
// 브라우저에서 Gemini를 직접 부르면 자격증명이 소스에 노출되므로, 인증 정보는 이 함수의
// 환경변수에만 두고 브라우저는 /api/gemini 를 호출한다.
//
// 두 가지 호출 경로를 지원한다. 둘 다 설정돼 있으면 Vertex AI 를 쓴다.
//
//  1) Vertex AI  (권장 · 사내 인보이스 결제 계정에서 동작)
//     GCP_SERVICE_ACCOUNT_JSON : 서비스 계정 키 JSON 전체를 한 줄로 붙여넣기
//     VERTEX_LOCATION          : (선택) 기본값 us-central1
//
//  2) AI Studio API 키 (개인/무료 등급용)
//     GEMINI_API_KEY : https://aistudio.google.com/apikey 에서 발급
//
//  공통
//     GEMINI_MODEL : (선택) 기본값 gemini-2.5-flash
//
// 인증: Firebase 로그인 토큰을 검증해 @seah.co.kr 계정만 통과시킨다.
//       (이 함수 주소는 공개돼 있으므로 검증이 없으면 아무나 호출량을 소모할 수 있다)

const crypto = require('crypto');

const PROJECT_ID = 'equip-analytics1-common';
const ALLOWED_DOMAIN = 'seah.co.kr';
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const MAX_CONTEXT_CHARS = 200000;

const model = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const vertexLocation = () => process.env.VERTEX_LOCATION || 'us-central1';

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------------------
// Firebase ID 토큰 검증 (구글 공개키로 서명 확인, 외부 패키지 없이)
// ---------------------------------------------------------------------------
let certCache = { certs: null, expiresAt: 0 };

async function getCerts() {
    if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
    const r = await fetch(CERT_URL);
    if (!r.ok) throw new Error('구글 공개키를 가져오지 못했습니다.');
    const certs = await r.json();
    const maxAge = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
    certCache = { certs, expiresAt: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
    return certs;
}

async function verifyIdToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('토큰 형식이 올바르지 않습니다.');

    const header = JSON.parse(b64url(parts[0]).toString('utf8'));
    const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid) throw new Error('지원하지 않는 서명 방식입니다.');

    const pem = (await getCerts())[header.kid];
    if (!pem) throw new Error('알 수 없는 서명 키입니다.');

    const ok = crypto.createVerify('RSA-SHA256')
        .update(`${parts[0]}.${parts[1]}`)
        .verify(pem, b64url(parts[2]));
    if (!ok) throw new Error('서명이 유효하지 않습니다.');

    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== PROJECT_ID) throw new Error('다른 프로젝트의 토큰입니다.');
    if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('발급자가 올바르지 않습니다.');
    if (!payload.sub) throw new Error('사용자 정보가 없습니다.');
    if (!(payload.exp > now)) throw new Error('토큰이 만료되었습니다. 새로고침 후 다시 시도하세요.');

    const email = String(payload.email || '').toLowerCase();
    if (!email.endsWith('@' + ALLOWED_DOMAIN)) throw new Error('사내 계정만 사용할 수 있습니다.');
    return payload;
}

// ---------------------------------------------------------------------------
// Vertex AI: 서비스 계정 키로 액세스 토큰을 직접 발급 (google-auth-library 없이)
// ---------------------------------------------------------------------------
function serviceAccount() {
    const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let sa;
    try {
        sa = JSON.parse(raw);
    } catch (e) {
        throw new Error('GCP_SERVICE_ACCOUNT_JSON 이 올바른 JSON 이 아닙니다. 키 파일 내용을 그대로 붙여넣었는지 확인하세요.');
    }
    if (!sa.client_email || !sa.private_key) throw new Error('서비스 계정 JSON 에 client_email 또는 private_key 가 없습니다.');
    // 환경변수 편집기에서 줄바꿈이 \n 문자열로 들어간 경우를 복구
    if (sa.private_key.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
}

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(sa) {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;

    const now = Math.floor(Date.now() / 1000);
    const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64urlEncode(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    }));
    const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key);
    const assertion = `${header}.${claim}.${b64urlEncode(signature)}`;

    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`액세스 토큰 발급 실패: ${j.error_description || j.error || r.status}`);

    tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
    return j.access_token;
}

// 두 경로 모두 요청/응답 형식이 같아서 본문은 그대로 쓰고 호출 주소만 다르다.
async function callModel(body) {
    const sa = serviceAccount();
    if (sa) {
        const loc = vertexLocation();
        const token = await getAccessToken(sa);
        const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/${loc}/publishers/google/models/${model()}:generateContent`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        const j = await r.json();
        return { ok: r.ok, status: r.status, json: j, mode: 'vertex' };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GCP_SERVICE_ACCOUNT_JSON 또는 GEMINI_API_KEY 중 하나가 설정되어야 합니다.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const j = await r.json();
    return { ok: r.ok, status: r.status, json: j, mode: 'aistudio' };
}

const SYSTEM_PROMPT = `당신은 세아씨엠 설비의 예방보전·고장 데이터를 분석하는 설비 엔지니어입니다.
사용자의 질문에 대해 아래 [데이터]만 근거로 한국어로 답하십시오.

규칙:
- [데이터]에 없는 내용은 추측하지 말고 "데이터에 없습니다"라고 분명히 말하십시오.
- 숫자는 반드시 [데이터]에서 직접 세거나 계산한 값을 쓰고, 어떤 기준으로 집계했는지 한 줄로 밝히십시오.
- 데이터가 특정 연도/라인으로 걸러져 있으면, 답변의 전제로 그 범위를 먼저 밝히십시오.
- 답변은 간결하게. 여러 항목을 비교할 때는 마크다운 표를 쓰십시오.
- 설비 담당자가 바로 행동할 수 있게, 마지막에 필요하면 짧은 제안을 덧붙이십시오.`;

function extractText(j) {
    const cand = (j.candidates || [])[0];
    if (!cand) return '';
    return ((cand.content && cand.content.parts) || []).map(p => p.text).filter(Boolean).join('');
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // 로그인 검증을 먼저 한다. 외부에서 이 주소를 찔러도 내부 설정 상태가 드러나지 않도록.
    const authHeader = req.headers.authorization || '';
    try {
        await verifyIdToken(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
    } catch (e) {
        return res.status(401).json({ error: `인증 실패: ${e.message}` });
    }

    // ---- 설치 확인 ----
    // 자격증명이 없어도 진단 정보를 돌려줘야 어디가 잘못됐는지 알 수 있으므로 먼저 처리한다.
    // 키나 비공개 키 '값'은 절대 내보내지 않는다.
    if (req.method === 'GET') {
        let sa = null, saError = null;
        try { sa = serviceAccount(); } catch (e) { saError = e.message; }

        const diag = {
            mode: sa ? 'vertex' : (process.env.GEMINI_API_KEY ? 'aistudio' : 'none'),
            configuredModel: model(),
            vertex: sa ? { project: sa.project_id, location: vertexLocation(), serviceAccount: sa.client_email } : null,
            hasKey: !!process.env.GEMINI_API_KEY,
            keyLength: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 0,
            vercelEnv: process.env.VERCEL_ENV || null,
            vercelUrl: process.env.VERCEL_URL || null,
            gitRepo: process.env.VERCEL_GIT_REPO_SLUG || null,
            gitCommit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
            similarKeys: Object.keys(process.env).filter(k => /GEMINI|GENAI|VERTEX|GCP_|GOOGLE|API_?KEY/i.test(k)).sort()
        };

        if (saError) return res.status(200).json({ ...diag, error: saError });
        if (diag.mode === 'none') {
            return res.status(200).json({ ...diag, error: 'GCP_SERVICE_ACCOUNT_JSON 또는 GEMINI_API_KEY 가 이 배포에 전달되지 않았습니다.' });
        }

        // 실제로 한 번 호출해 봐야 권한·모델 접근까지 확인된다 (아주 짧게)
        try {
            const probe = await callModel({
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 8, temperature: 0 }
            });
            if (!probe.ok) {
                const msg = (probe.json && probe.json.error && probe.json.error.message)
                    || (Array.isArray(probe.json) && probe.json[0] && probe.json[0].error && probe.json[0].error.message)
                    || `HTTP ${probe.status}`;
                return res.status(200).json({ ...diag, error: msg });
            }
            return res.status(200).json({ ...diag, ok: true });
        } catch (e) {
            return res.status(200).json({ ...diag, error: e.message });
        }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });

    const { question, context, history } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: '질문이 비어 있습니다.' });
    if (String(context || '').length > MAX_CONTEXT_CHARS) {
        return res.status(413).json({ error: '분석 범위가 너무 넓습니다. 연도나 라인을 좁혀 주세요.' });
    }

    const body = {
        systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n[데이터]\n${context || '(없음)'}` }] },
        contents: [
            // 이어지는 질문을 이해하도록 최근 대화만 함께 보낸다
            ...(Array.isArray(history) ? history : []).slice(-6).map(h => ({
                role: h.role === 'model' ? 'model' : 'user',
                parts: [{ text: String(h.text || '').slice(0, 4000) }]
            })),
            { role: 'user', parts: [{ text: String(question).slice(0, 2000) }] }
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    };

    try {
        const r = await callModel(body);
        if (!r.ok) {
            const msg = (r.json && r.json.error && r.json.error.message)
                || (Array.isArray(r.json) && r.json[0] && r.json[0].error && r.json[0].error.message)
                || `모델 호출 실패 (HTTP ${r.status})`;
            return res.status(r.status).json({ error: msg });
        }
        const text = extractText(r.json);
        if (!text) {
            const cand = (r.json.candidates || [])[0];
            const reason = (cand && cand.finishReason) || (r.json.promptFeedback && r.json.promptFeedback.blockReason) || '알 수 없음';
            return res.status(502).json({ error: `응답이 비어 있습니다. (사유: ${reason})` });
        }
        return res.status(200).json({ text, usage: r.json.usageMetadata || null, model: model(), mode: r.mode });
    } catch (e) {
        return res.status(502).json({ error: `모델 호출 실패: ${e.message}` });
    }
};
