// 주간 점검 보고 메일 (Vercel 서버리스 함수)
//
// 라인별 담당자에게 [이번 주 점검 예정 + 지연 항목 + 지난주 점검 실적]을 보낸다.
// 한 사람이 여러 라인을 맡으면 그 라인들을 한 통에 묶어 보낸다.
//
// 호출 방법
//   GET  /api/report-mail                 → 진단 (설정 상태만, 발송하지 않음)
//   GET  /api/report-mail?preview=1       → 미리보기 (받는 사람·본문을 돌려주고 발송하지 않음)
//   POST /api/report-mail                 → 실제 발송
//     body(선택): { lines:['CPL'], to:['a@seah.co.kr'], includeEmpty:false }
//        lines : 특정 라인만. 없으면 담당자가 지정된 전 라인
//        to    : 담당자 대신 이 주소로만 보냄 (시험 발송용)
//        includeEmpty : 지연·예정·실적이 모두 0인 담당자에게도 보낼지 (기본 false)
//
// 스케줄: vercel.json 의 크론이 매주 일요일 22:00 UTC = 월요일 07:00 KST 에 호출한다.
//
// 인증
//   - 사람이 부를 때 : Firebase ID 토큰(Authorization: Bearer ...) + 관리자만
//   - 크론이 부를 때 : Authorization: Bearer <CRON_SECRET>  (Vercel Cron 이 자동으로 붙임)
//
// 환경변수
//   GCP_SERVICE_ACCOUNT_JSON : Firestore 를 서버에서 읽기 위해 필요 (Vertex 용과 같은 값)
//   CRON_SECRET              : 스케줄 발송을 쓸 때. Vercel 이 이 값을 Bearer 로 보낸다
//   메일 발송 설정은 api/_lib/mailer.js 주석 참고 (Gmail 또는 Resend)
//   PUBLIC_SITE_URL          : (선택) 메일 하단에 넣을 사이트 주소

const {
    SUPER_ADMIN, normEmail, verifyIdToken, serviceAccount, getAccessToken,
    SECRET_PATH, DATA_PARENT, dataPath, fsGet, fsList, fsQuerySince
} = require('./_lib/google');
const { sendMail, mailMode } = require('./_lib/mailer');
const { weekWindows, buildLineSection, composeMail } = require('./_lib/weekly-report');

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

// 발송 실패 한 건이 전체를 멈추지 않도록, 사람 단위로 나눠 보내고 결과를 모은다.
async function sendAll(jobs, ctx) {
    const sent = [], failed = [];
    for (const job of jobs) {
        try {
            const r = await sendMail(job.mail, ctx);
            sent.push({ to: job.to, lines: job.lines, id: r.id, mode: r.mode });
        } catch (e) {
            failed.push({ to: job.to, lines: job.lines, error: e.message });
        }
    }
    return { sent, failed };
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const cronSecret = process.env.CRON_SECRET;
    const isCron = !!(cronSecret && bearer && bearer === cronSecret);

    // ---- 인증 ----
    let caller = null;
    if (!isCron) {
        try {
            const payload = await verifyIdToken(bearer);
            caller = normEmail(payload.email);
        } catch (e) {
            return res.status(401).json({ error: `인증 실패: ${e.message}` });
        }
    }

    // ---- 설정 진단 (발송 없음) ----
    // 자격증명 '값'은 절대 내보내지 않는다.
    let sa = null, saError = null;
    try { sa = serviceAccount(); } catch (e) { saError = e.message; }

    const baseDiag = {
        hasServiceAccount: !!sa,
        serviceAccount: sa ? sa.client_email : null,
        gmailSender: process.env.GMAIL_SENDER || null,
        hasOAuthClient: !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
        hasCronSecret: !!cronSecret,
        siteUrl: process.env.PUBLIC_SITE_URL || null,
        vercelEnv: process.env.VERCEL_ENV || null,
        gitCommit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null
    };
    const wantsPreview = String((req.query && req.query.preview) || '') === '1';

    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET 또는 POST 만 지원합니다.' });
    if (saError) return res.status(500).json({ ...baseDiag, error: saError });
    if (!sa) return res.status(500).json({ ...baseDiag, error: 'GCP_SERVICE_ACCOUNT_JSON 이 설정되어 있지 않습니다.' });

    // 저장된 Gmail 연결(본인 1회 동의)을 읽어야 발송 경로가 정해진다.
    let mailCtx = {};
    let diag = { ...baseDiag, mailMode: 'none' };
    try {
        const t = await getAccessToken(sa, FIRESTORE_SCOPE);
        const auth = await fsGet(t, `${SECRET_PATH}/gmailAuth`);
        if (auth && auth.refreshToken) mailCtx = { oauth: { refreshToken: auth.refreshToken, email: auth.email } };
        diag = {
            ...baseDiag,
            mailMode: mailMode(mailCtx),
            gmailConnected: !!mailCtx.oauth,
            gmailAccount: mailCtx.oauth ? mailCtx.oauth.email : null
        };
    } catch (e) {
        return res.status(500).json({ ...baseDiag, error: `설정을 읽지 못했습니다: ${e.message}` });
    }

    // ---- 설정 진단 (발송 없음) ----
    if (req.method === 'GET' && !isCron && !wantsPreview) {
        if (diag.mailMode === 'none') {
            return res.status(200).json({
                ...diag,
                error: diag.hasOAuthClient
                    ? '아직 Gmail 이 연결되지 않았습니다. [Gmail 연결] 을 눌러 한 번만 동의해 주세요.'
                    : 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET 이 등록되어 있지 않습니다.'
            });
        }
        return res.status(200).json({ ...diag, ok: true });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const onlyLines = Array.isArray(body.lines) && body.lines.length ? body.lines.map(String) : null;
    const overrideTo = Array.isArray(body.to) && body.to.length ? body.to.map(normEmail).filter(Boolean) : null;
    const includeEmpty = body.includeEmpty === true;
    // 미리보기는 발송하지 않는다. 크론은 항상 발송한다.
    const dryRun = isCron ? false : (req.method === 'GET' || wantsPreview);

    try {
        const token = await getAccessToken(sa, FIRESTORE_SCOPE);

        // ---- 관리자 확인 (사람이 부른 경우만) ----
        const adminsDoc = await fsGet(token, dataPath('settings/admins'));
        const adminList = ((adminsDoc && adminsDoc.emails) || []).map(normEmail);
        if (!isCron) {
            const isAdmin = caller === normEmail(SUPER_ADMIN) || adminList.includes(caller);
            if (!isAdmin) return res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
        }

        // ---- 데이터 읽기 ----
        const win = weekWindows(new Date());

        const ownersDoc = await fsGet(token, dataPath('settings/lineOwners'));
        const lineOwners = (ownersDoc && ownersDoc.lines) || {};
        // 담당 구분 { CPL: { 'a@seah.co.kr': '전기' } } — 없으면 '전체'(구분 안 가림)
        const ownerCats = (ownersDoc && ownersDoc.cats) || {};
        const catOf = (line, email) => {
            const c = ((ownerCats[line] || {})[normEmail(email)] || '').trim();
            return ['전기', '기계'].includes(c) ? c : '전체';
        };
        // 점검 항목은 지연을 보려면 오래된 것까지 다 필요하다 (설비×주기 수만큼이라 양이 제한적).
        // 실적은 계속 쌓이므로 지난주 앞뒤로 여유를 두고 등록시각 기준으로 좁혀 읽는다.
        //   checkedAt(서버 등록시각)으로 거르고, 실제 기간 판정은 checkTime(현장 입력) 기준으로 한다.
        //   현장에서 며칠 지난 날짜를 적어 넣는 경우가 있어 넉넉히 14일 앞에서 끊는다.
        const resultsSince = new Date(`${win.lastWeek.from}T00:00:00Z`).getTime() - 14 * 86400000;
        const [pmTasks, pmResults] = await Promise.all([
            fsList(token, dataPath('pm_tasks')),
            fsQuerySince(token, DATA_PARENT, 'pm_results', 'checkedAt', resultsSince)
        ]);

        const siteUrl = process.env.PUBLIC_SITE_URL || null;

        // ---- 라인별 집계 ----
        const targetLines = (onlyLines || Object.keys(lineOwners))
            .filter(l => onlyLines ? true : (lineOwners[l] || []).length);
        if (!targetLines.length) {
            return res.status(200).json({
                ...diag, dryRun,
                error: '담당자가 지정된 라인이 없습니다. [라인별 담당자] 에서 먼저 지정하세요.'
            });
        }
        // ---- 받는 사람별로 (라인 + 담당구분) 묶기 ----
        // 같은 라인이라도 전기 담당과 기계 담당이 받는 내용이 달라야 하므로,
        // 집계는 라인이 아니라 '라인+구분' 단위로 만든다.
        // 시험 발송(to 지정)이면 그 사람들에게 대상 라인 전체를 구분 없이 한 통으로 보낸다.
        const byRecipient = new Map();  // email -> [{ line, cat }]
        if (overrideTo) {
            overrideTo.forEach(em => byRecipient.set(em, targetLines.map(line => ({ line, cat: '전체' }))));
        } else {
            targetLines.forEach(line => {
                (lineOwners[line] || []).forEach(raw => {
                    const em = normEmail(raw);
                    if (!em) return;
                    if (!byRecipient.has(em)) byRecipient.set(em, []);
                    byRecipient.get(em).push({ line, cat: catOf(line, em) });
                });
            });
        }

        // 라인+구분 조합별로 한 번씩만 집계한다 (같은 조합을 여러 담당자가 공유)
        const sections = new Map();
        const sectionOf = (line, cat) => {
            const key = `${line}|${cat}`;
            if (!sections.has(key)) sections.set(key, buildLineSection(line, pmTasks, pmResults, win, cat));
            return sections.get(key);
        };
        // 요약 표시는 구분을 가리지 않은 라인 전체 기준으로 보여준다
        const lineSummary = targetLines.map(l => ({ line: l, ...buildLineSection(l, pmTasks, pmResults, win).counts, owners: (lineOwners[l] || []).length }));

        const jobs = [];
        const skipped = [];
        for (const [to, assigns] of byRecipient) {
            const secs = assigns.map(a => sectionOf(a.line, a.cat)).filter(Boolean);
            const label = assigns.map(a => a.line + (a.cat !== '전체' ? `(${a.cat})` : ''));
            if (!includeEmpty && secs.every(s => s.empty)) {
                skipped.push({ to, lines: label, reason: '지연·예정·실적이 모두 없음' });
                continue;
            }
            const mail = composeMail(secs, win, { siteUrl, toName: to.split('@')[0] });
            jobs.push({
                to, lines: label,
                mail: { to, subject: mail.subject, html: mail.html, text: mail.text },
                totals: mail.totals
            });
        }

        const summary = {
            ...diag,
            dryRun,
            window: win,
            lines: lineSummary,
            recipients: jobs.map(j => ({ to: j.to, lines: j.lines, subject: j.mail.subject, ...j.totals })),
            skipped
        };

        if (dryRun) {
            // 미리보기에서는 첫 통의 본문까지 함께 돌려줘 화면에서 그대로 확인할 수 있게 한다.
            return res.status(200).json({
                ...summary,
                previewHtml: jobs.length ? jobs[0].mail.html : null,
                previewSubject: jobs.length ? jobs[0].mail.subject : null
            });
        }

        if (diag.mailMode === 'none') return res.status(500).json({ ...summary, error: '메일 발송 설정이 없습니다.' });
        if (!jobs.length) return res.status(200).json({ ...summary, sent: [], failed: [], message: '보낼 대상이 없습니다.' });

        const { sent, failed } = await sendAll(jobs, mailCtx);
        return res.status(failed.length && !sent.length ? 502 : 200).json({ ...summary, sent, failed });
    } catch (e) {
        return res.status(500).json({ ...diag, error: e.message });
    }
};
