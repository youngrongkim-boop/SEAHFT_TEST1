// 주간 점검 보고서 만들기 — 담당자에게 보낼 내용을 라인별로 집계한다.
//
// 담는 것
//   1) 이번 주 점검 예정   : 아직 점검하지 않았고 예정일이 이번 주(월~일) 안인 항목
//   2) 지연된 점검         : 예정일이 이미 지난 미점검 항목 (가장 먼저 봐야 하므로 맨 위)
//   3) 지난주 점검 실적    : 지난 월~일 사이에 등록된 실적 요약 + 불량 내역
//
// ※ 서버에서 도는 코드라 index.html 의 함수를 쓸 수 없다. 유형 판정·주기 정규화처럼
//   화면과 뜻이 같아야 하는 규칙은 여기에도 같은 내용으로 둔다. 한쪽만 고치면 어긋난다.

// ---- 점검유형 (index.html 의 WORK_TYPES / LEGACY_WORK_TYPES 와 같은 값) ----
const PLANNED_WORK_TYPES = ['예방점검'];
const ADHOC_WORK_TYPES = ['긴급점검', '일반점검'];
const WORK_TYPES = ['예방점검', '긴급점검', '일반점검'];
const LEGACY_WORK_TYPES = { '법정점검': '예방점검', '특별점검': '예방점검', '돌발점검': '일반점검' };

const normalizeWorkType = (v) => {
    const s = String(v || '').trim();
    if (WORK_TYPES.includes(s)) return s;
    return LEGACY_WORK_TYPES[s] || '예방점검';
};
const isAdhocType = (v) => ADHOC_WORK_TYPES.includes(normalizeWorkType(v));

function normalizeCycle(val) {
    const s = String(val || '').trim().toLowerCase();
    if (s.includes('일') || s.includes('daily')) return '일별';
    if (s.includes('주') || s.includes('week')) return '주별';
    if (s.includes('분기') || s.includes('quarter')) return '분기별';
    if (s.includes('연') || s.includes('년') || s.includes('year')) return '연별';
    return '월별';
}

// ---- 날짜: Vercel 은 UTC 로 도므로 한국 시간 기준으로 계산해야 한다 ----
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const kstDateStr = (d) => new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
// 월요일 시작 주. getUTCDay(): 일=0 → 월요일까지 며칠 뒤로 갈지 계산
function mondayOf(ymd) {
    const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
    return addDays(ymd, -((dow + 6) % 7));
}

function weekWindows(nowDate) {
    const today = kstDateStr(nowDate || new Date());
    const thisMon = mondayOf(today);
    return {
        today,
        thisWeek: { from: thisMon, to: addDays(thisMon, 6) },
        lastWeek: { from: addDays(thisMon, -7), to: addDays(thisMon, -1) }
    };
}

// 실적의 점검일시: 현장에서 넣은 checkTime 우선, 없으면 서버 등록시각
function resultTimeStr(r) {
    if (r.checkTime) return String(r.checkTime).replace('T', ' ');
    if (r.checkedAt && r.checkedAt.seconds) {
        const d = new Date(r.checkedAt.seconds * 1000 + KST_OFFSET_MS);
        return d.toISOString().slice(0, 16).replace('T', ' ');
    }
    return '';
}
const resultDate = (r) => resultTimeStr(r).slice(0, 10);

// ---------------------------------------------------------------------------
// 라인 하나에 대한 집계
// ---------------------------------------------------------------------------
// cat: '전체' | '전기' | '기계' — 담당 구분. 전체(또는 미지정)면 구분을 가리지 않는다.
const coversCat = (cat, d) => !cat || cat === '전체' || String(d.category || '').trim() === cat;

function buildLineSection(line, pmTasks, pmResults, win, cat) {
    const tasks = pmTasks.filter(t => t.line === line && coversCat(cat, t));
    const results = pmResults.filter(r => r.line === line && coversCat(cat, r));

    const pending = tasks.filter(t => t.status !== '점검');
    const overdue = pending
        .filter(t => t.nextCheckDate && t.nextCheckDate < win.today)
        .sort((a, b) => String(a.nextCheckDate).localeCompare(String(b.nextCheckDate)));
    const dueThisWeek = pending
        .filter(t => t.nextCheckDate && t.nextCheckDate >= win.today && t.nextCheckDate <= win.thisWeek.to)
        .sort((a, b) => String(a.nextCheckDate).localeCompare(String(b.nextCheckDate)));

    const done = results.filter(r => {
        const ds = resultDate(r);
        return ds && ds >= win.lastWeek.from && ds <= win.lastWeek.to;
    }).sort((a, b) => resultTimeStr(b).localeCompare(resultTimeStr(a)));

    const bad = done.filter(r => r.result === '불량');
    const byType = WORK_TYPES.map(t => ({
        type: t,
        count: done.filter(r => normalizeWorkType(r.workType) === t).length
    })).filter(x => x.count);

    return {
        line,
        cat: cat && cat !== '전체' ? cat : null,   // 화면에 '(전기)' 처럼 덧붙이기 위함
        today: win.today,
        overdue, dueThisWeek, done, bad, byType,
        counts: {
            overdue: overdue.length,
            dueThisWeek: dueThisWeek.length,
            done: done.length,
            good: done.length - bad.length,
            bad: bad.length
        },
        // 볼 것이 하나도 없으면 메일을 보내지 않기 위한 판단 근거
        empty: !overdue.length && !dueThisWeek.length && !done.length
    };
}

// ---------------------------------------------------------------------------
// HTML / 텍스트 본문
// 메일 클라이언트(아웃룩 포함)에서 깨지지 않게 인라인 스타일 + 표만 쓴다.
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cell = (s) => esc(String(s ?? '').trim() || '-');

const TD = 'padding:6px 8px;border:1px solid #d8dee9;font-size:12px;vertical-align:top;';
const TH = 'padding:6px 8px;border:1px solid #d8dee9;font-size:12px;background:#f1f5f9;text-align:left;white-space:nowrap;';

function htmlTable(head, rows, opts = {}) {
    if (!rows.length) return `<p style="margin:4px 0 14px;font-size:12px;color:#64748b;">${esc(opts.empty || '해당 없음')}</p>`;
    return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:4px 0 16px;">
<thead><tr>${head.map(h => `<th style="${TH}">${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r, i) => `<tr${i % 2 ? ' style="background:#fafbfc;"' : ''}>${r.map(c => `<td style="${TD}">${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>`;
}

const dday = (ymd, today) => Math.round((new Date(`${ymd}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);

function sectionHtml(sec, win) {
    const c = sec.counts;
    const chip = (label, n, color) =>
        `<span style="display:inline-block;padding:3px 9px;margin:0 6px 6px 0;border-radius:11px;font-size:12px;font-weight:bold;background:${color.bg};color:${color.fg};border:1px solid ${color.bd};">${esc(label)} ${n}</span>`;

    let h = `<h2 style="margin:26px 0 8px;font-size:16px;color:#0f172a;border-bottom:2px solid #1e40af;padding-bottom:5px;">${esc(sec.line)} 라인`
        + (sec.cat ? ` <span style="font-size:12px;color:#475569;font-weight:normal;">· ${esc(sec.cat)} 담당</span>` : '') + `</h2>`;
    h += '<div style="margin:8px 0 12px;">'
        + chip('점검지연', c.overdue, c.overdue ? { bg: '#fee2e2', fg: '#b91c1c', bd: '#fca5a5' } : { bg: '#f1f5f9', fg: '#64748b', bd: '#cbd5e1' })
        + chip('금주 예정', c.dueThisWeek, { bg: '#fef3c7', fg: '#92400e', bd: '#fcd34d' })
        + chip('지난주 실적', c.done, { bg: '#dbeafe', fg: '#1e40af', bd: '#93c5fd' })
        + chip('불량', c.bad, c.bad ? { bg: '#fee2e2', fg: '#b91c1c', bd: '#fca5a5' } : { bg: '#f1f5f9', fg: '#64748b', bd: '#cbd5e1' })
        + '</div>';

    h += `<h3 style="margin:16px 0 4px;font-size:13px;color:#b91c1c;">1. 점검 지연 (${c.overdue}건)</h3>`;
    h += htmlTable(['예정일', '경과', '설비', '주기', '점검 내용'],
        sec.overdue.slice(0, 40).map(t => [
            t.nextCheckDate, `${Math.abs(dday(t.nextCheckDate, sec.today))}일`,
            t.equipmentName, normalizeCycle(t.cycleType), t.taskDetails
        ]), { empty: '지연된 점검이 없습니다.' });
    if (sec.overdue.length > 40) h += `<p style="font-size:11px;color:#64748b;margin:-10px 0 14px;">외 ${sec.overdue.length - 40}건</p>`;

    h += `<h3 style="margin:16px 0 4px;font-size:13px;color:#92400e;">2. 금주 점검 예정 (${c.dueThisWeek}건) · ${win.thisWeek.from} ~ ${win.thisWeek.to}</h3>`;
    h += htmlTable(['예정일', 'D-', '설비', '주기', '점검 내용', '점검기준'],
        sec.dueThisWeek.slice(0, 60).map(t => [
            t.nextCheckDate, `D-${dday(t.nextCheckDate, sec.today)}`,
            t.equipmentName, normalizeCycle(t.cycleType), t.taskDetails, t.criteria
        ]), { empty: '이번 주 예정된 점검이 없습니다.' });
    if (sec.dueThisWeek.length > 60) h += `<p style="font-size:11px;color:#64748b;margin:-10px 0 14px;">외 ${sec.dueThisWeek.length - 60}건</p>`;

    h += `<h3 style="margin:16px 0 4px;font-size:13px;color:#1e40af;">3. 지난주 점검 실적 (${c.done}건) · ${win.lastWeek.from} ~ ${win.lastWeek.to}</h3>`;
    if (!sec.done.length) {
        h += '<p style="margin:4px 0 14px;font-size:12px;color:#64748b;">지난주 등록된 점검 실적이 없습니다.</p>';
    } else {
        h += `<p style="margin:4px 0 8px;font-size:12px;color:#334155;">양호 <b>${c.good}</b> · 불량 <b style="color:#b91c1c;">${c.bad}</b>`
            + (sec.byType.length ? ` &nbsp;|&nbsp; ${sec.byType.map(x => `${esc(x.type)} ${x.count}`).join(' · ')}` : '')
            + '</p>';
        if (sec.bad.length) {
            h += `<p style="margin:10px 0 4px;font-size:12px;font-weight:bold;color:#b91c1c;">불량 내역 (${sec.bad.length}건)</p>`;
            h += htmlTable(['점검일시', '유형', '설비', '점검 내용', '특이사항', '점검자'],
                sec.bad.slice(0, 30).map(r => [
                    resultTimeStr(r), normalizeWorkType(r.workType), r.equipmentName,
                    r.taskDetails, r.remarks, r.checkedByName
                ]));
        }
        h += `<p style="margin:10px 0 4px;font-size:12px;font-weight:bold;color:#334155;">실적 목록 (최대 40건)</p>`;
        h += htmlTable(['점검일시', '유형', '설비', '점검 내용', '결과', '점검자'],
            sec.done.slice(0, 40).map(r => [
                resultTimeStr(r), normalizeWorkType(r.workType), r.equipmentName,
                r.taskDetails, r.result, r.checkedByName
            ]));
        if (sec.done.length > 40) h += `<p style="font-size:11px;color:#64748b;margin:-10px 0 14px;">외 ${sec.done.length - 40}건</p>`;
    }
    return h;
}

function sectionText(sec, win) {
    const c = sec.counts;
    const L = [];
    L.push(`■ ${sec.line} 라인${sec.cat ? ` · ${sec.cat} 담당` : ''}`);
    L.push(`   점검지연 ${c.overdue} / 금주예정 ${c.dueThisWeek} / 지난주실적 ${c.done} (불량 ${c.bad})`);
    if (sec.overdue.length) {
        L.push(`   [지연] ${sec.overdue.length}건`);
        sec.overdue.slice(0, 15).forEach(t => L.push(`     - ${t.nextCheckDate} ${t.equipmentName} : ${t.taskDetails}`));
        if (sec.overdue.length > 15) L.push(`     외 ${sec.overdue.length - 15}건`);
    }
    if (sec.dueThisWeek.length) {
        L.push(`   [금주 예정] ${sec.dueThisWeek.length}건 (${win.thisWeek.from}~${win.thisWeek.to})`);
        sec.dueThisWeek.slice(0, 15).forEach(t => L.push(`     - ${t.nextCheckDate} ${t.equipmentName} : ${t.taskDetails}`));
        if (sec.dueThisWeek.length > 15) L.push(`     외 ${sec.dueThisWeek.length - 15}건`);
    }
    if (sec.bad.length) {
        L.push(`   [지난주 불량] ${sec.bad.length}건`);
        sec.bad.slice(0, 15).forEach(r => L.push(`     - ${resultTimeStr(r)} ${r.equipmentName} : ${r.taskDetails}${r.remarks ? ' / ' + r.remarks : ''}`));
    }
    L.push('');
    return L.join('\n');
}

// 받는 사람 한 명이 여러 라인을 맡을 수 있으므로, 그 사람 몫의 라인을 한 통에 담는다.
function composeMail(sections, win, { siteUrl, toName } = {}) {
    const tot = sections.reduce((a, s) => ({
        overdue: a.overdue + s.counts.overdue,
        due: a.due + s.counts.dueThisWeek,
        done: a.done + s.counts.done,
        bad: a.bad + s.counts.bad
    }), { overdue: 0, due: 0, done: 0, bad: 0 });

    const lines = sections.map(s => s.line + (s.cat ? `(${s.cat})` : '')).join(', ');
    const subject = `[설비관리] 주간 점검 보고 (${win.thisWeek.from}~${win.thisWeek.to}) · ${lines}`
        + ` · 지연 ${tot.overdue} / 금주예정 ${tot.due}`;

    const html = `<div style="font-family:'Malgun Gothic','맑은 고딕',AppleSDGothicNeo-Regular,sans-serif;color:#0f172a;max-width:860px;margin:0 auto;padding:20px 22px;">
<h1 style="margin:0 0 4px;font-size:19px;">주간 점검 보고</h1>
<p style="margin:0 0 4px;font-size:13px;color:#475569;">
  ${toName ? esc(toName) + ' 담당자님 · ' : ''}담당 라인 <b>${esc(lines)}</b>
</p>
<p style="margin:0 0 16px;font-size:12px;color:#64748b;">
  금주 ${win.thisWeek.from} ~ ${win.thisWeek.to} &nbsp;|&nbsp; 지난주 실적 ${win.lastWeek.from} ~ ${win.lastWeek.to} &nbsp;|&nbsp; 기준일 ${win.today}
</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;">
  <tr>
    <td style="${TD}background:#fef2f2;"><b style="color:#b91c1c;">점검지연 ${tot.overdue}건</b></td>
    <td style="${TD}background:#fffbeb;"><b style="color:#92400e;">금주 예정 ${tot.due}건</b></td>
    <td style="${TD}background:#eff6ff;"><b style="color:#1e40af;">지난주 실적 ${tot.done}건</b></td>
    <td style="${TD}background:${tot.bad ? '#fef2f2' : '#f8fafc'};"><b style="color:${tot.bad ? '#b91c1c' : '#64748b'};">불량 ${tot.bad}건</b></td>
  </tr>
</table>
${sections.map(s => sectionHtml(s, win)).join('')}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:26px 0 10px;">
<p style="font-size:11px;color:#94a3b8;margin:0;">
  세아씨엠 설비 관리 시스템이 자동으로 보낸 메일입니다. 등록된 데이터를 집계한 결과입니다.
  ${siteUrl ? `<br><a href="${esc(siteUrl)}" style="color:#1e40af;">${esc(siteUrl)}</a> 에서 점검 결과를 등록할 수 있습니다.` : ''}
</p>
</div>`;

    const text = [
        '주간 점검 보고',
        `담당 라인: ${lines}`,
        `금주 ${win.thisWeek.from} ~ ${win.thisWeek.to} / 지난주 실적 ${win.lastWeek.from} ~ ${win.lastWeek.to} / 기준일 ${win.today}`,
        `합계: 점검지연 ${tot.overdue} · 금주예정 ${tot.due} · 지난주실적 ${tot.done} (불량 ${tot.bad})`,
        '',
        ...sections.map(s => sectionText(s, win)),
        siteUrl || ''
    ].join('\n');

    return { subject, html, text, totals: tot };
}

module.exports = {
    weekWindows, buildLineSection, composeMail,
    normalizeWorkType, isAdhocType, normalizeCycle, resultTimeStr, resultDate
};
