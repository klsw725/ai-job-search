import { useMemo, useState } from "react";
import { safeHttpUrl, useFetch } from "../api.ts";
import { GATES, isVetoed } from "../jobs.ts";
import { Card, CommandButton, Deadline, ErrorBox, StatusChip } from "../ui.tsx";

type Job = Record<string, unknown> & { key: string };

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function Jobs() {
  const { data, error, reload } = useFetch<{ exists: boolean; jobs: Job[]; error?: string }>("/api/jobs");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  const jobs = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.jobs ?? [])
      .filter((j) => status === "all" || j.status === status)
      .filter((j) => !needle || `${str(j.title)} ${str(j.company)} ${str(j.portal)}`.toLowerCase().includes(needle))
      .sort((a, b) => (Number(b.rank_score ?? -1) - Number(a.rank_score ?? -1)) || str(b.first_seen ?? b.posted_date).localeCompare(str(a.first_seen ?? a.posted_date)));
  }, [data, q, status]);

  const statuses = [...new Set((data?.jobs ?? []).map((j) => str(j.status)).filter(Boolean))];

  return (
    <div className="stack">
      <h1>공고</h1>
      <ErrorBox error={error ?? data?.error ?? null} />
      <Card
        title={`수집된 공고 ${data?.jobs.length ?? 0}건`}
        actions={
          <>
            <CommandButton prompt="/scrape" label="새로 검색" />
            <CommandButton prompt="/rank" label="순위 매기기" />
            <button className="btn secondary" onClick={reload}>새로고침</button>
          </>
        }
      >
        <div className="row">
          <input placeholder="회사·직무 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">전체 상태</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {data && !data.exists ? (
          <p className="muted">아직 수집된 공고가 없습니다. /scrape를 실행하거나, 채용 사이트에서 찾은 공고 URL을 대시보드의 "새 공고 지원"에 넣으세요.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>점수</th>
                <th>회사</th>
                <th>직무</th>
                <th>출처</th>
                <th>상태</th>
                <th>마감</th>
                <th>강점 / 갭</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const url = safeHttpUrl(j.url);
                return (
                  <tr key={j.key}>
                    <td className="num">{j.rank_score === undefined ? "-" : str(j.rank_score)}</td>
                    <td>{str(j.company)}</td>
                    <td>
                      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{str(j.title)}</a> : str(j.title)}
                      {isVetoed(j) && <span className="chip st-rejected">추천 제외</span>}
                      {GATES.map(([field, label, noteField]) =>
                        j[field] && j[field] !== "PASS" ? (
                          <span key={field} className={j[field] === "FAIL" ? "chip st-rejected" : "chip warn"} title={noteField ? str(j[noteField]) : undefined}>
                            {label} {str(j[field])}
                          </span>
                        ) : null,
                      )}
                      {GATES.map(([field, , noteField]) =>
                        noteField && j[field] && j[field] !== "PASS" && j[noteField] ? (
                          <div key={noteField} className="small muted">{str(j[noteField])}</div>
                        ) : null,
                      )}
                    </td>
                    <td>{str(j.portal)}</td>
                    <td><StatusChip status={str(j.status)} /></td>
                    <td><Deadline date={str(j.deadline) || null} /></td>
                    <td className="small">
                      {Array.isArray(j.strengths) && <div>+ {j.strengths.map(str).join(", ")}</div>}
                      {Array.isArray(j.gaps) && <div className="muted">− {j.gaps.map(str).join(", ")}</div>}
                    </td>
                    <td>{url && <CommandButton prompt={`/apply ${url}`} label="지원" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
