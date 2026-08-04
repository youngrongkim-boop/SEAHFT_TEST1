// 메일 발송 (외부 패키지 없이 fetch 만 사용)
//
// 설정된 경로 중 위에서부터 쓴다.
//
//  1) Gmail · 본인 1회 동의  ← 지금 쓰는 방식
//     보내는 사람 본인이 구글 동의 화면에서 [허용] 을 한 번 누르면 끝. 관리자 승인이 필요 없다.
//     발급된 갱신용 토큰은 Firestore 비공개 경로에 저장되고, 발송할 때마다 서버가 알아서 쓴다.
//     설정: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET  (연결은 /api/gmail-auth)
//
//  2) Gmail · 도메인 전체 위임 (관리자 승인 필요)
//     GMAIL_SENDER            : 보내는 사람 주소
//     GCP_SERVICE_ACCOUNT_JSON: 서비스 계정 (Vertex 용과 같은 값)
//     ※ Workspace 관리콘솔에서 그 서비스 계정에 도메인 전체 위임 + gmail.send 범위 승인 필요
//
//  3) Resend (외부 서비스)
//     RESEND_API_KEY / MAIL_FROM
//     ※ seah.co.kr 주소로 보내려면 도메인 인증(DNS)이 필요하다. 안 하면 스팸 처리될 수 있다.
//
// 공통: MAIL_FROM_NAME — 받는 사람에게 보이는 표시 이름. 기본값 '설비관리 시스템'

const { serviceAccount, getAccessToken } = require('./google');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ctx.oauth = { refreshToken, email } 이 있으면 1) 방식을 쓴다.
function mailMode(ctx) {
    if (ctx && ctx.oauth && ctx.oauth.refreshToken
        && process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) return 'gmail-oauth';
    if (process.env.GMAIL_SENDER && process.env.GCP_SERVICE_ACCOUNT_JSON) return 'gmail';
    if (process.env.RESEND_API_KEY) return 'resend';
    return 'none';
}

// 갱신용 토큰으로 액세스 토큰을 받아온다. 액세스 토큰은 1시간짜리라 함수 인스턴스 내에서만 재사용.
const oauthCache = new Map();
async function oauthAccessToken(refreshToken) {
    const hit = oauthCache.get(refreshToken);
    if (hit && Date.now() < hit.expiresAt - 60000) return hit.token;

    const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            grant_type: 'refresh_token'
        })
    });
    const j = await r.json();
    if (!r.ok) {
        const hint = j.error === 'invalid_grant'
            ? ' 연결이 풀렸습니다(비밀번호 변경·접근 취소 등). [Gmail 연결]을 다시 한 번 눌러 주세요.' : '';
        throw new Error(`토큰 갱신 실패: ${j.error_description || j.error || r.status}.${hint}`);
    }
    oauthCache.set(refreshToken, { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
}

// 제목에 한글이 있으면 RFC 2047 로 인코딩해야 깨지지 않는다.
const encodeHeader = (s) => /^[\x20-\x7E]*$/.test(String(s || ''))
    ? String(s || '')
    : `=?UTF-8?B?${Buffer.from(String(s || ''), 'utf8').toString('base64')}?=`;

// Gmail API 는 RFC 822 원문을 base64url 로 받는다.
function buildRawMessage({ from, to, cc, subject, html, text }) {
    const boundary = 'bnd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const lines = [
        `From: ${from}`,
        `To: ${[].concat(to).join(', ')}`,
        ...(cc && cc.length ? [`Cc: ${[].concat(cc).join(', ')}`] : []),
        `Subject: ${encodeHeader(subject)}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(text || '', 'utf8').toString('base64'),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(html || '', 'utf8').toString('base64'),
        '',
        `--${boundary}--`,
        ''
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fromName = () => process.env.MAIL_FROM_NAME || '설비관리 시스템';

// Gmail API 로 실제 발송. 받는 사람에게는 sender 주소가 '보낸 사람'으로 찍히고
// 답장도 그 주소로 간다. 발송된 메일은 그 계정의 '보낸편지함'에 남는다.
async function gmailSend(accessToken, sender, { to, cc, subject, html, text }, mode) {
    const raw = buildRawMessage({
        from: `${encodeHeader(fromName())} <${sender}>`,
        to, cc, subject, html, text
    });
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ raw })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        const msg = (j.error && (j.error.message || j.error.status)) || `HTTP ${r.status}`;
        throw new Error(`Gmail 발송 실패: ${msg}`);
    }
    return { id: j.id, mode };
}

// 1) 본인 1회 동의 방식
async function sendViaGmailOAuth(msg, ctx) {
    const token = await oauthAccessToken(ctx.oauth.refreshToken);
    return gmailSend(token, ctx.oauth.email || 'me', msg, 'gmail-oauth');
}

// 2) 도메인 전체 위임 방식
async function sendViaGmail(msg) {
    const sender = process.env.GMAIL_SENDER;
    const sa = serviceAccount();
    if (!sa) throw new Error('GCP_SERVICE_ACCOUNT_JSON 이 없습니다.');
    const token = await getAccessToken(sa, GMAIL_SCOPE, sender);
    return gmailSend(token, sender, msg, 'gmail');
}

async function sendViaResend({ to, cc, subject, html, text }) {
    const from = process.env.MAIL_FROM || `${fromName()} <onboarding@resend.dev>`;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
            from,
            to: [].concat(to),
            ...(cc && cc.length ? { cc: [].concat(cc) } : {}),
            subject, html, text
        })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend 발송 실패: ${j.message || j.name || `HTTP ${r.status}`}`);
    return { id: j.id, mode: 'resend' };
}

async function sendMail(msg, ctx) {
    const mode = mailMode(ctx);
    if (mode === 'gmail-oauth') return sendViaGmailOAuth(msg, ctx);
    if (mode === 'gmail') return sendViaGmail(msg);
    if (mode === 'resend') return sendViaResend(msg);
    throw new Error('메일 발송 설정이 없습니다. [라인별 담당자] 화면에서 [Gmail 연결] 을 먼저 진행하세요.');
}

module.exports = { sendMail, mailMode };
