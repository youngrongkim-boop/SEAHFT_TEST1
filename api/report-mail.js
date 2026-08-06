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
// 스케줄: vercel.json 의 크론이 매시 정각(UTC)에 호출하고, 실제로 보낼지는
//   Firestore 의 settings/reportMail (켜짐·요일·시각)을 보고 이 함수가 정한다.
//   화면(라인별 담당자 → 주간 점검 보고 메일)에서 바꾸면 재배포 없이 바로 적용된다.
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
    SECRET_PATH, DATA_PARENT, dataPath, fsGet, fsList, fsQuerySince, fsSet
} = require('./_lib/google');
const { sendMail, mailMode } = require('./_lib/mailer');
const { weekWindows, buildLineSection, composeMail } = require('./_lib/weekly-report');

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

// ---------------------------------------------------------------------------
// 자동 발송 스케줄
//
// vercel.json 의 크론은 매시 정각(UTC)에 이 함수를 부른다. 실제로 보낼지는
// Firestore 의 settings/reportMail 을 보고 여기서 정한다. 이렇게 해두면
// 최고관리자가 화면에서 켜고 끄거나 요일·시각을 바꿔도 재배포가 필요 없다.
//   enabled : 자동 발송 사용 여부 (기본 켜짐)
//   weekday : 0=일 … 6=토, -1 이면 매일 (기본 1=월요일)
//   hour    : 한국 시각 0~23 (기본 6시). 크론이 정시에만 돌므로 분 단위는 없다.
// ---------------------------------------------------------------------------
const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ⚠️ 크론이 실제로 오는 한국 시각. vercel.json 의 schedule 과 반드시 같아야 한다.
//    지금 "0 21 * * *" = 매일 21:00 UTC = 06:00 KST → [6]
//
//    Vercel 무료(Hobby) 요금제는 크론을 하루 한 번까지만 허용해서 시간당 실행이 거부된다.
//    그래서 고를 수 있는 시각이 이 목록으로 제한된다. 시각을 자유롭게 고르려면
//      · Vercel Pro 로 올려 schedule 을 "0 * * * *" 로 바꾸거나
//      · Google Cloud Scheduler(Asia/Seoul, 매시)에서 이 주소를 호출하게 하면 된다.
//    둘 중 무엇을 하든 여기와 index.html 의 RM_CRON_HOURS 를 0~23 전체로 넓히면 끝난다.
const CRON_HOURS_KST = [6];

// 서버는 UTC 로 도므로 한국 시각의 요일·시·날짜를 직접 계산한다
function kstParts(d) {
    const k = new Date(d.getTime() + KST_OFFSET_MS);
    const y = k.getUTCFullYear();
    const m = String(k.getUTCMonth() + 1).padStart(2, '0');
    const day = String(k.getUTCDate()).padStart(2, '0');
    const hour = k.getUTCHours();
    return {
        weekday: k.getUTCDay(), hour,
        date: `${y}-${m}-${day}`,
        key: `${y}-${m}-${day}-${String(hour).padStart(2, '0')}`
    };
}

// 저장된 값이 비었거나 이상해도 항상 쓸 수 있는 값으로 정리한다
function resolveSchedule(cfg) {
    // null·빈 문자열은 Number() 가 0 으로 바꿔 버린다. 0 은 '일요일'·'0시'로 유효한 값이라
    // 그대로 두면 값이 비었을 때 엉뚱한 시각에 발송된다. 먼저 걸러 기본값으로 되돌린다.
    const num = (v, dflt, min, max) => {
        if (v === null || v === undefined || v === '') return dflt;
        const n = Number(v);
        return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
    };
    const s = {
        enabled: (cfg || {}).enabled !== false,
        weekday: num((cfg || {}).weekday, 1, -1, 6),
        hour: num((cfg || {}).hour, 6, 0, 23)
    };
    // 크론이 오지 않는 시각이 저장돼 있으면 메일이 영영 안 나간다.
    // 조용히 멈추는 것보다 실제로 크론이 오는 시각에 보내는 편이 안전하다.
    s.hourAdjusted = !CRON_HOURS_KST.includes(s.hour);
    if (s.hourAdjusted) s.hour = CRON_HOURS_KST[0];
    s.cronHours = CRON_HOURS_KST;
    s.label = s.enabled
        ? `${s.weekday < 0 ? '매일' : '매주 ' + WEEKDAY_NAMES[s.weekday] + '요일'} ${String(s.hour).padStart(2, '0')}:00 자동 발송`
        : '자동 발송 꺼짐';
    return s;
}

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

    // ---- 인증 · 권한 ----
    // 발송 계정 연결이 걸려 있어 최고관리자만 다룬다.
    // 설정 진단에도 연결 계정·환경변수 상태가 담기므로, 아래 어떤 처리보다 먼저 막는다.
    let caller = null;
    if (!isCron) {
        try {
            const payload = await verifyIdToken(bearer);
            caller = normEmail(payload.email);
        } catch (e) {
            return res.status(401).json({ error: `인증 실패: ${e.message}` });
        }
        if (caller !== normEmail(SUPER_ADMIN)) {
            return res.status(403).json({ error: '주간 보고 메일은 최고관리자만 사용할 수 있습니다.' });
        }
    }

    // ---- 설정 진단 (발송 없음) ----
    // 자격증명 '값'은 절대 내보내지 않는다.
    let sa = null, saError = null;
    try { sa = serviceAccount(); } catch (e) { saError = e.message; }

    // 환경변수가 이 배포까지 전달됐는지 확인용.
    // 값은 절대 내보내지 않고, '이름이 있는지'와 '길이'만 본다.
    //  - 이름 목록이 비어 있으면 → 다른 Vercel 프로젝트에 넣었거나 저장이 안 된 것
    //  - 이름은 있는데 길이가 0이면 → 값 칸이 비어 있는 것
    const envNames = Object.keys(process.env)
        .filter(k => /OAUTH|GMAIL|MAIL_|CRON|PUBLIC_SITE|GCP_|RESEND/i.test(k)).sort();
    const len = (k) => (process.env[k] || '').trim().length;

    const baseDiag = {
        hasServiceAccount: !!sa,
        serviceAccount: sa ? sa.client_email : null,
        gmailSender: process.env.GMAIL_SENDER || null,
        hasOAuthClient: !!(len('GOOGLE_OAUTH_CLIENT_ID') && len('GOOGLE_OAUTH_CLIENT_SECRET')),
        hasCronSecret: !!cronSecret,
        siteUrl: process.env.PUBLIC_SITE_URL || null,
        vercelEnv: process.env.VERCEL_ENV || null,
        vercelUrl: process.env.VERCEL_URL || null,
        gitRepo: process.env.VERCEL_GIT_REPO_SLUG || null,
        gitCommit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
        envNames,
        envLengths: {
            GOOGLE_OAUTH_CLIENT_ID: len('GOOGLE_OAUTH_CLIENT_ID'),
            GOOGLE_OAUTH_CLIENT_SECRET: len('GOOGLE_OAUTH_CLIENT_SECRET'),
            PUBLIC_SITE_URL: len('PUBLIC_SITE_URL'),
            MAIL_FROM_NAME: len('MAIL_FROM_NAME'),
            CRON_SECRET: len('CRON_SECRET'),
            GCP_SERVICE_ACCOUNT_JSON: len('GCP_SERVICE_ACCOUNT_JSON')
        }
    };
    const wantsPreview = String((req.query && req.query.preview) || '') === '1';

    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET 또는 POST 만 지원합니다.' });
    if (saError) return res.status(500).json({ ...baseDiag, error: saError });
    if (!sa) return res.status(500).json({ ...baseDiag, error: 'GCP_SERVICE_ACCOUNT_JSON 이 설정되어 있지 않습니다.' });

    // 저장된 Gmail 연결(본인 1회 동의)을 읽어야 발송 경로가 정해진다.
    let mailCtx = {};
    let mailCfg = {};
    let diag = { ...baseDiag, mailMode: 'none' };
    try {
        const t = await getAccessToken(sa, FIRESTORE_SCOPE);
        const auth = await fsGet(t, `${SECRET_PATH}/gmailAuth`);
        if (auth && auth.refreshToken) mailCtx = { oauth: { refreshToken: auth.refreshToken, email: auth.email } };
        mailCfg = (await fsGet(t, dataPath('settings/reportMail'))) || {};
        diag = {
            ...baseDiag,
            mailMode: mailMode(mailCtx),
            gmailConnected: !!mailCtx.oauth,
            gmailAccount: mailCtx.oauth ? mailCtx.oauth.email : null
        };
    } catch (e) {
        return res.status(500).json({ ...baseDiag, error: `설정을 읽지 못했습니다: ${e.message}` });
    }

    // ---- 자동 발송 스케줄 판정 ----
    // 크론은 매시 정각에 오지만, 실제로 보내는 것은 설정한 요일·시각 한 번뿐이다.
    const schedule = resolveSchedule(mailCfg);
    const nowKst = kstParts(new Date());
    diag.schedule = schedule;
    diag.nowKst = { weekday: WEEKDAY_NAMES[nowKst.weekday], hour: nowKst.hour, date: nowKst.date };
    diag.lastRunKey = mailCfg.lastRunKey || null;
    diag.lastRunAt = mailCfg.lastRunAt || null;
    diag.lastRunResult = mailCfg.lastRunResult || null;

    if (isCron) {
        const skip = (why) => res.status(200).json({ ...diag, skipped: why });
        if (!schedule.enabled) return skip('자동 발송이 꺼져 있습니다.');
        if (schedule.weekday >= 0 && nowKst.weekday !== schedule.weekday) {
            return skip(`발송 요일이 아닙니다. (설정 ${WEEKDAY_NAMES[schedule.weekday]}요일 · 오늘 ${WEEKDAY_NAMES[nowKst.weekday]}요일)`);
        }
        if (nowKst.hour !== schedule.hour) {
            return skip(`발송 시각이 아닙니다. (설정 ${schedule.hour}시 · 지금 ${nowKst.hour}시 KST)`);
        }
        // 같은 시각에 크론이 두 번 오더라도 두 번 보내지 않는다
        if (mailCfg.lastRunKey === nowKst.key) return skip(`이미 이 시각에 발송했습니다. (${nowKst.key})`);
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

        // ---- 데이터 읽기 ---- (권한은 위에서 이미 확인했다)
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

        // 자동 발송이었으면 실행 기록을 남긴다 (같은 시각 중복 발송 방지 + 화면 표시용).
        // fsSet 은 문서를 통째로 덮어쓰므로 남길 필드를 모두 적어 준다.
        if (isCron) {
            try {
                await fsSet(token, dataPath('settings/reportMail'), {
                    enabled: schedule.enabled,
                    weekday: schedule.weekday,
                    hour: schedule.hour,
                    lastRunKey: nowKst.key,
                    lastRunAt: new Date(),
                    lastRunResult: `발송 ${sent.length}명${failed.length ? ` · 실패 ${failed.length}명` : ''}`,
                    updatedBy: '자동 발송'
                });
            } catch (e) {
                console.error('자동 발송 기록 저장 실패:', e.message);
            }
        }
        return res.status(failed.length && !sent.length ? 502 : 200).json({ ...summary, sent, failed });
    } catch (e) {
        return res.status(500).json({ ...diag, error: e.message });
    }
};
