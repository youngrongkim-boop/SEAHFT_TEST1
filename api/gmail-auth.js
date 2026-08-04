// Gmail 연결 (본인 1회 동의 방식)
//
// 관리자 승인 없이, 보내는 사람 본인이 구글 동의 화면에서 [허용] 을 한 번 누르면
// '갱신용 토큰'이 발급된다. 그 토큰을 Firestore 의 비공개 경로에 저장해 두고,
// 이후에는 발송할 때마다 서버가 알아서 새 액세스 토큰을 받아 쓴다.
// → 매번 다시 동의할 필요가 없고, 동의한 사람이 자리에 없어도 자동 발송된다.
//
// 필요한 환경변수
//   GOOGLE_OAUTH_CLIENT_ID     : GCP > API 및 서비스 > 사용자 인증 정보 > OAuth 클라이언트 ID(웹 애플리케이션)
//   GOOGLE_OAUTH_CLIENT_SECRET : 위 클라이언트의 보안 비밀
//   PUBLIC_SITE_URL            : (권장) 예: https://seahft.vercel.app
//                                리디렉션 URI 를 이 주소 기준으로 만든다. 없으면 요청 호스트를 쓴다.
//
// GCP 에 등록할 리디렉션 URI :  <사이트주소>/api/gmail-auth
//
// 호출 방법
//   GET /api/gmail-auth?action=status   (로그인 토큰 필요) → 연결 상태
//   GET /api/gmail-auth?action=start    (로그인 토큰 필요) → 동의 화면 주소를 돌려준다
//   GET /api/gmail-auth?code=..&state=..                   → 구글이 되돌려 보내는 주소 (브라우저)
//   POST /api/gmail-auth {action:'disconnect'} (로그인 토큰) → 연결 해제

const crypto = require('crypto');
const {
    SUPER_ADMIN, SECRET_PATH, normEmail, verifyIdToken,
    serviceAccount, getAccessToken, dataPath, fsGet, fsSet, fsDelete
} = require('./_lib/google');

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60 * 1000;

const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const clientId = () => process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

function redirectUri(req) {
    const base = (process.env.PUBLIC_SITE_URL || `https://${req.headers.host}`).replace(/\/+$/, '');
    return `${base}/api/gmail-auth`;
}

// 동의 절차를 시작한 사람이 맞는지 확인하려고 state 에 서명을 넣는다.
// (서명이 없으면 아무나 콜백 주소를 흉내 내 남의 토큰을 저장시킬 수 있다)
function signState(payload) {
    const body = b64urlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', clientSecret()).update(body).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${body}.${sig}`;
}
function verifyState(state) {
    const [body, sig] = String(state || '').split('.');
    if (!body || !sig) throw new Error('state 형식이 올바르지 않습니다.');
    const expect = crypto.createHmac('sha256', clientSecret()).update(body).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw new Error('state 서명이 맞지 않습니다.');
    const payload = JSON.parse(b64urlDecode(body));
    if (!(payload.exp > Date.now())) throw new Error('연결 요청이 만료되었습니다. 다시 시도하세요.');
    return payload;
}

const page = (title, body, ok) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:'Malgun Gothic','맑은 고딕',system-ui,sans-serif;background:#f1f5f9;margin:0;padding:40px 20px;">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:30px 28px;box-shadow:0 2px 12px rgba(0,0,0,.08);">
  <div style="font-size:40px;line-height:1;margin-bottom:14px;">${ok ? '✅' : '⚠️'}</div>
  <h1 style="margin:0 0 12px;font-size:19px;color:#0f172a;">${title}</h1>
  <div style="font-size:14px;color:#334155;line-height:1.7;">${body}</div>
  <p style="margin-top:22px;font-size:12px;color:#94a3b8;">이 창은 닫으셔도 됩니다.</p>
</div></body></html>`;

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const q = req.query || {};

    // ---- 구글이 되돌려 보내는 단계 (브라우저 이동) ----
    if (req.method === 'GET' && (q.code || q.error)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        try {
            if (q.error) throw new Error(`구글에서 거부되었습니다 (${q.error}). 회사 정책으로 외부 앱 접근이 막혀 있을 수 있습니다.`);
            if (!clientId() || !clientSecret()) throw new Error('GOOGLE_OAUTH_CLIENT_ID / SECRET 이 설정되어 있지 않습니다.');

            const state = verifyState(q.state);

            const r = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code: String(q.code),
                    client_id: clientId(),
                    client_secret: clientSecret(),
                    redirect_uri: redirectUri(req),
                    grant_type: 'authorization_code'
                })
            });
            const j = await r.json();
            if (!r.ok) throw new Error(`토큰 발급 실패: ${j.error_description || j.error || r.status}`);
            if (!j.refresh_token) {
                throw new Error('갱신용 토큰이 오지 않았습니다. 구글 계정의 기존 연결을 해제한 뒤 다시 시도하세요. '
                    + '(구글 계정 → 보안 → 서드파티 앱)');
            }

            // 실제로 동의한 사람이 시작한 사람과 같은지 확인
            const idPayload = j.id_token ? JSON.parse(b64urlDecode(j.id_token.split('.')[1])) : {};
            const consented = normEmail(idPayload.email);
            if (consented && consented !== normEmail(state.email)) {
                throw new Error(`연결을 시작한 계정(${state.email})과 동의한 계정(${consented})이 다릅니다. 같은 계정으로 다시 시도하세요.`);
            }

            const sa = serviceAccount();
            if (!sa) throw new Error('GCP_SERVICE_ACCOUNT_JSON 이 없어 저장할 수 없습니다.');
            const fsToken = await getAccessToken(sa, FIRESTORE_SCOPE);
            await fsSet(fsToken, `${SECRET_PATH}/gmailAuth`, {
                refreshToken: j.refresh_token,
                email: consented || normEmail(state.email),
                scope: j.scope || GMAIL_SCOPE,
                connectedBy: normEmail(state.email),
                connectedAt: new Date()
            });

            return res.status(200).send(page('Gmail 연결이 완료되었습니다',
                `이제부터 <b>${consented || state.email}</b> 계정으로 주간 점검 보고 메일이 나갑니다.<br>`
                + '<b>다시 동의하실 필요는 없습니다.</b> 매주 월요일 아침 7시에 자동으로 발송됩니다.<br><br>'
                + '설비관리 시스템으로 돌아가 <b>[라인별 담당자] → [연결 확인]</b> 을 눌러 상태를 확인하세요.', true));
        } catch (e) {
            return res.status(200).send(page('Gmail 연결에 실패했습니다',
                `${String(e.message).replace(/</g, '&lt;')}<br><br>설비관리 시스템에서 다시 시도해 주세요.`, false));
        }
    }

    // ---- 여기부터는 앱에서 부르는 단계 (로그인 토큰 필요) ----
    const authHeader = req.headers.authorization || '';
    let caller = null;
    try {
        const payload = await verifyIdToken(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
        caller = normEmail(payload.email);
    } catch (e) {
        return res.status(401).json({ error: `인증 실패: ${e.message}` });
    }

    let sa = null, saError = null;
    try { sa = serviceAccount(); } catch (e) { saError = e.message; }
    if (saError) return res.status(500).json({ error: saError });
    if (!sa) return res.status(500).json({ error: 'GCP_SERVICE_ACCOUNT_JSON 이 설정되어 있지 않습니다.' });

    const fsToken = await getAccessToken(sa, FIRESTORE_SCOPE);
    const adminsDoc = await fsGet(fsToken, dataPath('settings/admins'));
    const adminList = ((adminsDoc && adminsDoc.emails) || []).map(normEmail);
    const isAdmin = caller === normEmail(SUPER_ADMIN) || adminList.includes(caller);
    if (!isAdmin) return res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });

    const action = String(q.action || (req.body && req.body.action) || 'status');

    if (action === 'disconnect') {
        await fsDelete(fsToken, `${SECRET_PATH}/gmailAuth`);
        return res.status(200).json({ ok: true, connected: false });
    }

    const saved = await fsGet(fsToken, `${SECRET_PATH}/gmailAuth`);
    const status = {
        connected: !!(saved && saved.refreshToken),
        email: (saved && saved.email) || null,
        connectedBy: (saved && saved.connectedBy) || null,
        connectedAt: (saved && saved.connectedAt && saved.connectedAt.seconds)
            ? new Date(saved.connectedAt.seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : null,
        hasOAuthClient: !!(clientId() && clientSecret()),
        redirectUri: redirectUri(req)
    };

    if (action === 'status') return res.status(200).json(status);

    if (action === 'start') {
        if (!status.hasOAuthClient) {
            return res.status(400).json({
                ...status,
                error: 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET 이 등록되어 있지 않습니다. '
                    + `GCP 에서 OAuth 클라이언트를 만들고 리디렉션 URI 로 ${status.redirectUri} 를 등록하세요.`
            });
        }
        const state = signState({ email: caller, exp: Date.now() + STATE_TTL_MS });
        const url = `${AUTH_URL}?` + new URLSearchParams({
            client_id: clientId(),
            redirect_uri: redirectUri(req),
            response_type: 'code',
            scope: `openid email ${GMAIL_SCOPE}`,
            access_type: 'offline',       // 갱신용 토큰을 받기 위해 필요
            prompt: 'consent',            // 이미 동의한 적 있어도 갱신용 토큰을 다시 받도록
            include_granted_scopes: 'true',
            login_hint: caller,
            hd: 'seah.co.kr',
            state
        }).toString();
        return res.status(200).json({ ...status, url });
    }

    return res.status(400).json({ error: `알 수 없는 action: ${action}` });
};
