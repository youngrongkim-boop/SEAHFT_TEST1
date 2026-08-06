// 예방점검 지연 자동 마감 (Vercel 서버리스 함수)
//
// 예정일이 지나도록 점검하지 않은 회차를 '미실시' 실적으로 남기고,
// 항목(pm_tasks)의 다음 예정일을 주기에 맞춰 앞으로 옮긴다.
//
// 왜 필요한가
//   예전에는 항목 1건이 예정일에 멈춘 채 계속 '점검지연'으로만 남았다.
//   그래서 며칠을 놓쳤는지는 알 수 있어도 "8월 일별점검 31회 중 28회 실시" 같은
//   회차 단위 집계가 불가능했다. 회차마다 실적 1건을 남기면 그게 가능해진다.
//
// 호출 방법
//   GET  /api/pm-rollover              → 미리보기 (무엇이 생길지만 계산, 쓰기 없음)
//   POST /api/pm-rollover              → 실제 실행
//   둘 다 최고관리자 토큰 또는 CRON_SECRET 이 필요하다.
//
// 스케줄: vercel.json 의 크론이 매일 15:00 UTC = 다음날 00:00 KST 에 호출한다.
//   자정 직후에 돌기 때문에 '어제까지 했어야 할 점검'이 그날 바로 실적으로 남는다.
//
// 안전장치
//   - 문서 ID 를 miss_{taskId}_{예정일} 로 고정한다 → 몇 번을 돌려도 중복 생성되지 않는다.
//   - settings/pmRollover.startDate 이전 회차는 만들지 않는다 (과거 소급 방지).
//     문서가 없으면 첫 실행일을 startDate 로 심는다 → 켜는 순간 과거가 쏟아지지 않는다.
//   - 항목 1건당 한 번에 만들 수 있는 회차 수를 MAX_PER_TASK 로 제한한다.

const {
    SUPER_ADMIN, normEmail, verifyIdToken, serviceAccount, getAccessToken,
    dataPath, fsGet, fsList, fsSet
} = require('./_lib/google');

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_PER_TASK = 40;     // 한 항목이 한 번에 만들 수 있는 미실시 회차 수
const MAX_TOTAL = 2000;      // 한 번 실행에서 만드는 전체 상한

// ---------------------------------------------------------------------------
// 날짜 계산 — 서버는 UTC 로 돌기 때문에 'YYYY-MM-DD' 문자열과 UTC 메서드만 쓴다.
// (index.html 의 calculatePeriodEndDate 와 같은 규칙: 주기의 '종료일'을 예정일로 본다)
// ---------------------------------------------------------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);

function kstToday() {
    return iso(new Date(Date.now() + KST_OFFSET_MS));
}

function normalizeCycle(val) {
    const s = String(val || '').trim().toLowerCase();
    if (s.includes('일') || s.includes('daily')) return '일별';
    if (s.includes('주') || s.includes('week')) return '주별';
    if (s.includes('분기') || s.includes('quarter')) return '분기별';
    if (s.includes('연') || s.includes('년') || s.includes('year')) return '연별';
    return '월별';
}

// 기준일이 속한 주기의 종료일 (offset 만큼 주기를 앞뒤로 옮긴다)
function periodEnd(baseDateStr, cycle, offset = 0) {
    const d = parse(baseDateStr);
    if (isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    let r;
    if (cycle === '일별') r = new Date(Date.UTC(y, m, day + offset));
    else if (cycle === '주별') r = new Date(Date.UTC(y, m, day + (6 - d.getUTCDay()) + offset * 7)); // 그 주의 토요일
    else if (cycle === '월별') r = new Date(Date.UTC(y, m + 1 + offset, 0));
    else if (cycle === '분기별') r = new Date(Date.UTC(y, (Math.floor(m / 3) + offset) * 3 + 3, 0));
    else if (cycle === '연별') r = new Date(Date.UTC(y + offset, 11, 31));
    else r = d;
    return iso(r);
}

// 어떤 예정일의 '다음 회차 예정일'
const nextOccurrence = (dueStr, cycle) => periodEnd(dueStr, cycle, 1);

const daysBetween = (fromStr, toStr) => Math.round((parse(toStr) - parse(fromStr)) / 86400000);

// ---------------------------------------------------------------------------
// 항목 1건이 만들어야 할 미실시 회차 목록을 계산한다 (쓰기 없음)
// ---------------------------------------------------------------------------
function planForTask(task, today, startDate) {
    const cycle = normalizeCycle(task.cycleType);
    const todayEnd = periodEnd(today, cycle, 0);   // 오늘이 속한 주기의 종료일
    let due = String(task.nextCheckDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
    if (due >= today) return null;                 // 아직 밀리지 않았다

    // 기준선(startDate) 이전부터 밀려 있던 것은 회차별로 쪼개지 않는다.
    // 기능을 켜는 순간 과거 수백 건이 쏟아지는 것을 막으면서도,
    // '밀려 있었다'는 사실은 한 건으로 남겨 조용히 사라지지 않게 한다.
    if (due < startDate) {
        return {
            cycle, backlog: true, capped: false, newDue: todayEnd,
            missed: [{ dueDate: due, overdueDays: daysBetween(due, today), backlog: true }]
        };
    }

    const missed = [];
    let capped = false;
    // 예정일이 오늘보다 이전이면 그 회차는 이미 놓친 것이다.
    // 오늘이 속한 주기 직전까지 앞으로 감으면서 놓친 회차를 모은다.
    while (due < today) {
        missed.push({ dueDate: due, overdueDays: daysBetween(due, today) });
        const nxt = nextOccurrence(due, cycle);
        if (!nxt || nxt <= due) break;             // 계산이 멈추면 무한루프 방지
        if (missed.length >= MAX_PER_TASK) { capped = true; due = nxt; break; } // 남은 회차는 다음 실행에서
        due = nxt;
        if (due >= todayEnd) break;                // 오늘 회차는 아직 할 수 있으므로 놓친 게 아니다
    }
    // 항목의 새 예정일: 오늘이 속한 주기의 종료일 (아직 오늘 몫은 남아 있다)
    const newDue = capped ? due : (due < todayEnd ? todayEnd : due);
    if (!missed.length) return null;
    return { cycle, missed, newDue, capped };
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const cronSecret = process.env.CRON_SECRET;
    const isCron = !!(cronSecret && bearer && bearer === cronSecret);

    if (!isCron) {
        try {
            const payload = await verifyIdToken(bearer);
            if (normEmail(payload.email) !== normEmail(SUPER_ADMIN)) {
                return res.status(403).json({ error: '지연 자동 마감은 최고관리자만 실행할 수 있습니다.' });
            }
        } catch (e) {
            return res.status(401).json({ error: `인증 실패: ${e.message}` });
        }
    }
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET 또는 POST 만 지원합니다.' });

    let sa;
    try { sa = serviceAccount(); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    const dryRun = req.method === 'GET';   // 크론은 POST 로 온다

    try {
        const token = await getAccessToken(sa, FIRESTORE_SCOPE);
        const today = kstToday();

        // ---- 설정 ----
        const cfgPath = dataPath('settings/pmRollover');
        const cfg = (await fsGet(token, cfgPath)) || {};
        if (cfg.enabled === false) {
            return res.status(200).json({ today, skipped: '자동 마감이 꺼져 있습니다.', enabled: false });
        }
        // 처음 켜는 날을 기준선으로 심는다 → 그 이전의 밀린 회차는 만들지 않는다
        const startDate = /^\d{4}-\d{2}-\d{2}$/.test(cfg.startDate || '') ? cfg.startDate : today;
        const firstRun = !cfg.startDate;

        // ---- 대상 항목 ----
        const tasks = await fsList(token, dataPath('pm_tasks'));
        const targets = tasks.filter(t =>
            t.status !== '점검'
            && String(t.workType || '예방점검').trim() === '예방점검'
            && String(t.nextCheckDate || '') < today);

        const plans = [];
        let total = 0;
        for (const t of targets) {
            const p = planForTask(t, today, startDate);
            if (!p) continue;
            if (total + p.missed.length > MAX_TOTAL) { p.missed = p.missed.slice(0, Math.max(0, MAX_TOTAL - total)); p.capped = true; }
            total += p.missed.length;
            plans.push({ task: t, ...p });
            if (total >= MAX_TOTAL) break;
        }

        const preview = plans.map(p => ({
            taskId: p.task.id, line: p.task.line, equipmentName: p.task.equipmentName,
            taskDetails: p.task.taskDetails, cycle: p.cycle,
            from: p.task.nextCheckDate, to: p.newDue,
            missed: p.missed.map(m => m.dueDate), capped: p.capped
        }));

        if (dryRun) {
            return res.status(200).json({
                dryRun: true, today, startDate, firstRun,
                taskCount: plans.length, resultCount: total, plans: preview.slice(0, 50)
            });
        }

        // ---- 실제 반영 ----
        let created = 0, skippedExisting = 0, failed = 0;
        for (const p of plans) {
            for (const m of p.missed) {
                // 문서 ID 를 예정일로 고정해 몇 번을 돌려도 같은 회차가 두 번 생기지 않게 한다
                const docId = `miss_${p.task.id}_${m.dueDate}`;
                const path = dataPath(`pm_results/${docId}`);
                try {
                    if (await fsGet(token, path)) { skippedExisting++; continue; } // 이미 있으면 손대지 않는다(사유 확인 보존)
                    await fsSet(token, path, {
                        taskId: p.task.id, workType: '예방점검',
                        line: p.task.line || '', equipmentName: p.task.equipmentName || '',
                        category: p.task.category || '', cycleType: p.cycle, criteria: p.task.criteria || '',
                        taskDetails: p.task.taskDetails || '', result: '미실시', remarks: '',
                        checkedByName: '자동 기록',
                        dueDate: m.dueDate, wasOverdue: true, overdueDays: m.overdueDays,
                        overdueExcused: false, excuseReason: '', excuseNote: '',
                        notPerformed: true, autoGenerated: true,
                        checkTime: `${m.dueDate}T23:59`,     // 그 회차 마감 시점으로 기록
                        checkedAt: new Date()
                    });
                    created++;
                } catch (e) {
                    failed++;
                    console.error('미실시 실적 생성 실패', docId, e.message);
                }
            }
            // 항목을 다음 회차로 옮긴다 (실적을 남기지 못했으면 옮기지 않는다)
            if (!failed) {
                try {
                    await fsSet(token, dataPath(`pm_tasks/${p.task.id}`), { ...stripId(p.task), nextCheckDate: p.newDue });
                } catch (e) {
                    console.error('예정일 이월 실패', p.task.id, e.message);
                }
            }
        }

        await fsSet(token, cfgPath, {
            enabled: true,
            startDate,
            lastRunDate: today,
            lastRunResult: `항목 ${plans.length}건 · 미실시 ${created}건 생성${skippedExisting ? ` · 기존 ${skippedExisting}건 유지` : ''}${failed ? ` · 실패 ${failed}건` : ''}`,
            lastRunAt: new Date()
        });

        return res.status(200).json({
            today, startDate, firstRun,
            taskCount: plans.length, created, skippedExisting, failed, plans: preview.slice(0, 50)
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

// fsGet 이 붙여 주는 id 는 문서 필드가 아니므로 다시 쓸 때 빼야 한다
function stripId(obj) {
    const { id, ...rest } = obj || {};
    return rest;
}
