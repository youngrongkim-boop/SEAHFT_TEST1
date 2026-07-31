// Gemini 프록시 (Vercel 서버리스 함수)
//
// 브라우저에서 Gemini를 직접 부르면 API 키가 소스에 노출되므로, 키는 이 함수의
// 환경변수에만 두고 브라우저는 /api/gemini 를 호출한다.
//
// 필요한 환경변수 (Vercel 대시보드 → Settings → Environment Variables)
//   GEMINI_API_KEY : https://aistudio.google.com/apikey 에서 발급
//   GEMINI_MODEL   : (선택) 기본값 gemini-2.5-flash
//
// 인증: Firebase 로그인 토큰을 검증해 @seah.co.kr 계정만 통과시킨다.
//       (이 함수 주소는 공개돼 있으므로 검증이 없으면 아무나 키를 소모할 수 있다)

const crypto = require('crypto');

const PROJECT_ID = 'equip-analytics1-common';
const ALLOWED_DOMAIN = 'seah.co.kr';
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const MAX_CONTEXT_CHARS = 200000;

const model = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ---- Firebase ID 토큰 검증 (google 공개키로 서명 확인, 외부 패키지 없이) ----
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

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

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

const SYSTEM_PROMPT = `당신은 세아씨엠 설비의 예방보전·고장 데이터를 분석하는 설비 엔지니어입니다.
사용자의 질문에 대해 아래 [데이터]만 근거로 한국어로 답하십시오.

규칙:
- [데이터]에 없는 내용은 추측하지 말고 "데이터에 없습니다"라고 분명히 말하십시오.
- 숫자는 반드시 [데이터]에서 직접 세거나 계산한 값을 쓰고, 어떤 기준으로 집계했는지 한 줄로 밝히십시오.
- 데이터가 특정 연도/라인으로 걸러져 있으면, 답변의 전제로 그 범위를 먼저 밝히십시오.
- 답변은 간결하게. 여러 항목을 비교할 때는 마크다운 표를 쓰십시오.
- 설비 담당자가 바로 행동할 수 있게, 마지막에 필요하면 짧은 제안을 덧붙이십시오.`;

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // 로그인 검증을 먼저 한다. 외부에서 이 주소를 찔러도 내부 설정 상태가 드러나지 않도록.
    const authHeader = req.headers.authorization || '';
    try {
        await verifyIdToken(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
    } catch (e) {
        return res.status(401).json({ error: `인증 실패: ${e.message}` });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    // 설치 확인용. 키가 없어도 진단 정보를 돌려줘야 어디가 잘못됐는지 알 수 있으므로
    // 키 검사보다 먼저 처리한다. 키 '값'은 절대 내보내지 않고 존재 여부와 길이만 알린다.
    if (req.method === 'GET') {
        const diag = {
            hasKey: !!apiKey,
            keyLength: apiKey ? apiKey.length : 0,
            // 이 배포가 어느 Vercel 프로젝트/커밋인지 (env 변수를 엉뚱한 프로젝트에 넣었는지 확인용)
            vercelEnv: process.env.VERCEL_ENV || null,
            vercelUrl: process.env.VERCEL_URL || null,
            gitRepo: process.env.VERCEL_GIT_REPO_SLUG || null,
            gitCommit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
            // 이름이 비슷한 환경변수가 있으면 오타를 잡을 수 있다 (이름만, 값은 제외)
            similarKeys: Object.keys(process.env).filter(k => /GEMINI|GENAI|GOOGLE|API_?KEY/i.test(k)).sort()
        };
        if (!apiKey) {
            return res.status(200).json({ ...diag, error: 'GEMINI_API_KEY가 이 배포에 전달되지 않았습니다.' });
        }
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            const j = await r.json();
            if (!r.ok) return res.status(200).json({ ...diag, error: (j.error && j.error.message) || '모델 목록 조회 실패' });
            return res.status(200).json({
                ...diag,
                configuredModel: model(),
                available: (j.models || [])
                    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                    .map(m => String(m.name).replace(/^models\//, ''))
            });
        } catch (e) {
            return res.status(200).json({ ...diag, error: `모델 목록 조회 실패: ${e.message}` });
        }
    }

    if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.' });
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
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent?key=${apiKey}`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json();

        if (!r.ok) {
            const msg = (j.error && j.error.message) || `Gemini 호출 실패 (HTTP ${r.status})`;
            return res.status(r.status).json({ error: msg });
        }

        const cand = (j.candidates || [])[0];
        const text = cand ? ((cand.content && cand.content.parts) || []).map(p => p.text).filter(Boolean).join('') : '';
        if (!text) {
            // 안전 필터 등으로 응답이 비는 경우
            const reason = (cand && cand.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || '알 수 없음';
            return res.status(502).json({ error: `응답이 비어 있습니다. (사유: ${reason})` });
        }
        return res.status(200).json({ text, usage: j.usageMetadata || null, model: model() });
    } catch (e) {
        return res.status(502).json({ error: `Gemini 호출 실패: ${e.message}` });
    }
};
