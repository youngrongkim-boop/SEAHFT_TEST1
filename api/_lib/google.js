// 구글 관련 공용 유틸 (Vercel 서버리스 함수용)
//
// api/ 아래에서 밑줄(_)로 시작하는 경로는 Vercel이 함수로 배포하지 않는다.
// 그래서 여기 있는 코드는 주소로 노출되지 않고, 다른 함수에서 require 로만 쓰인다.
//
// 외부 패키지를 쓰지 않는다. Node 내장 crypto 와 전역 fetch 만 사용하므로
// package.json / node_modules 가 필요 없다. (기존 api/gemini.js 와 같은 방침)
//
// ※ api/gemini.js 에도 같은 성격의 코드가 들어 있으나, 이미 배포되어 동작 중인
//   경로를 건드리지 않으려고 그대로 두었다. gemini.js 를 손볼 일이 생기면
//   그때 이 모듈을 쓰도록 바꾸는 편이 낫다.

const crypto = require('crypto');

const PROJECT_ID = 'equip-analytics1-common';
const FIRESTORE_DB = 'seahft1';          // 기본 DB 가 아닌 이름 있는 DB
const APP_ID = 'seah-cm-pdm-appid';      // index.html 의 appId 와 반드시 같아야 한다
const ALLOWED_DOMAIN = 'seah.co.kr';
const SUPER_ADMIN = 'youngrong.kim@seah.co.kr'; // index.html · firestore.rules 와 같은 값
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const normEmail = (e) => String(e || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Firebase ID 토큰 검증 (구글 공개키로 서명 확인)
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

    const email = normEmail(payload.email);
    if (!email.endsWith('@' + ALLOWED_DOMAIN)) throw new Error('사내 계정만 사용할 수 있습니다.');
    return payload;
}

// ---------------------------------------------------------------------------
// 서비스 계정 → OAuth 액세스 토큰
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
    if (sa.private_key.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
}

// scope·subject 조합마다 토큰이 다르므로 키를 나눠 캐시한다.
// (Gmail 대리 발송은 subject 가 붙어 Firestore 용 토큰과 별개다)
const tokenCache = new Map();

async function getAccessToken(sa, scope, subject) {
    const scopes = Array.isArray(scope) ? scope.join(' ') : (scope || 'https://www.googleapis.com/auth/cloud-platform');
    const key = `${sa.client_email}|${scopes}|${subject || ''}`;
    const hit = tokenCache.get(key);
    if (hit && Date.now() < hit.expiresAt - 60000) return hit.token;

    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss: sa.client_email,
        scope: scopes,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    };
    if (subject) claim.sub = subject; // 도메인 전체 위임(Workspace)으로 이 사용자를 대신해 호출

    const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64urlEncode(JSON.stringify(claim));
    const signature = crypto.createSign('RSA-SHA256').update(`${header}.${body}`).sign(sa.private_key);
    const assertion = `${header}.${body}.${b64urlEncode(signature)}`;

    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`액세스 토큰 발급 실패: ${j.error_description || j.error || r.status}`);

    tokenCache.set(key, { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
}

// ---------------------------------------------------------------------------
// Firestore REST — 브라우저 SDK 없이 서버에서 직접 읽는다.
// 스케줄 실행(크론)에는 사용자 토큰이 없으므로 서비스 계정으로 읽어야 한다.
// ---------------------------------------------------------------------------
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${FIRESTORE_DB}/documents`;
const DATA_PARENT = `artifacts/${APP_ID}/public/data`;   // 컬렉션들이 매달린 문서 경로
const dataPath = (rest) => `${DATA_PARENT}/${rest}`;

// Firestore REST 는 값에 타입 껍데기가 붙어 온다. 평범한 JS 값으로 되돌린다.
function decodeValue(v) {
    if (!v || typeof v !== 'object') return null;
    if ('nullValue' in v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('timestampValue' in v) return { seconds: Math.floor(new Date(v.timestampValue).getTime() / 1000) };
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
    return null;
}
function decodeFields(fields) {
    const out = {};
    for (const k of Object.keys(fields || {})) out[k] = decodeValue(fields[k]);
    return out;
}
const docId = (name) => String(name || '').split('/').pop();

// 평범한 JS 값 → Firestore REST 의 타입 껍데기
function encodeValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
    if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
    return { stringValue: String(v) };
}
function encodeFields(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) out[k] = encodeValue(obj[k]);
    return out;
}

async function fsGet(token, path) {
    const r = await fetch(`${FS_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return null;
    const j = await r.json();
    if (!r.ok) throw new Error(`Firestore 읽기 실패(${path}): ${(j.error && j.error.message) || r.status}`);
    return { id: docId(j.name), ...decodeFields(j.fields) };
}

// 컬렉션 전체를 페이지 단위로 받아온다. (문서 수가 많아도 누락되지 않게)
async function fsList(token, path, { pageSize = 300, maxDocs = 20000 } = {}) {
    const out = [];
    let pageToken = '';
    do {
        const qs = new URLSearchParams({ pageSize: String(pageSize) });
        if (pageToken) qs.set('pageToken', pageToken);
        const r = await fetch(`${FS_BASE}/${path}?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json();
        if (!r.ok) throw new Error(`Firestore 목록 실패(${path}): ${(j.error && j.error.message) || r.status}`);
        (j.documents || []).forEach(d => out.push({ id: docId(d.name), ...decodeFields(d.fields) }));
        pageToken = j.nextPageToken || '';
    } while (pageToken && out.length < maxDocs);
    return out;
}

// 특정 컬렉션에서 timestamp 필드가 기준 시각 이후인 문서만 가져온다.
// pm_results 처럼 계속 쌓이는 컬렉션을 전량 읽으면 함수 실행시간을 넘길 수 있어서,
// 주간 보고처럼 최근 것만 필요한 경우에는 이쪽을 쓴다.
// (단일 필드 색인은 Firestore 가 기본으로 만들어 두므로 별도 설정이 필요 없다)
async function fsQuerySince(token, parentPath, collectionId, field, sinceDate, limit = 5000) {
    const r = await fetch(`${FS_BASE}/${parentPath}:runQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: field },
                        op: 'GREATER_THAN_OR_EQUAL',
                        value: { timestampValue: new Date(sinceDate).toISOString() }
                    }
                },
                limit
            }
        })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Firestore 조회 실패(${collectionId}): ${(j.error && j.error.message) || r.status}`);
    return (Array.isArray(j) ? j : [])
        .filter(row => row && row.document)
        .map(row => ({ id: docId(row.document.name), ...decodeFields(row.document.fields) }));
}

// 문서 쓰기(있으면 덮어씀). 서비스 계정은 보안 규칙을 거치지 않으므로
// 클라이언트가 못 읽는 경로(artifacts/{appId}/private/...)에도 쓸 수 있다.
async function fsSet(token, path, data) {
    const r = await fetch(`${FS_BASE}/${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: encodeFields(data) })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Firestore 쓰기 실패(${path}): ${(j.error && j.error.message) || r.status}`);
    return { id: docId(j.name), ...decodeFields(j.fields) };
}

async function fsDelete(token, path) {
    const r = await fetch(`${FS_BASE}/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok && r.status !== 404) {
        const j = await r.json().catch(() => ({}));
        throw new Error(`Firestore 삭제 실패(${path}): ${(j.error && j.error.message) || r.status}`);
    }
    return true;
}

// 메일 발송용 자격증명 보관 위치.
// public/data 가 아니라서 firestore.rules 의 마지막 전면 차단 규칙에 걸린다
// → 브라우저(직원 누구든)에서는 읽을 수 없고, 서비스 계정으로만 접근된다.
//
// ※ Firestore 경로는 컬렉션/문서가 번갈아 나온다. 문서를 가리키려면 마디 수가 짝수여야 한다.
//    artifacts(컬)/appId(문)/private(컬)/gmailAuth(문) = 4마디 → 문서 (OK)
//    여기에 마디를 하나 더 붙이면 컬렉션이 되어 쓰기가 실패한다.
const SECRET_PATH = `artifacts/${APP_ID}/private`;

module.exports = {
    PROJECT_ID, FIRESTORE_DB, APP_ID, ALLOWED_DOMAIN, SUPER_ADMIN, SECRET_PATH,
    normEmail, verifyIdToken, serviceAccount, getAccessToken,
    DATA_PARENT, dataPath, fsGet, fsList, fsQuerySince, fsSet, fsDelete
};
