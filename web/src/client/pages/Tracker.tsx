import { Fragment, useState } from "react";
import { fileUrl, safeHttpUrl, useFetch } from "../api.ts";
import { Card, CommandButton, Deadline, ErrorBox, StatusChip } from "../ui.tsx";

type Row = Record<string, string>;
type FileEntry = { path: string };

function pdfFor(source: string | undefined, files: Set<string>): string | null {
  if (!source) return null;
  const pdf = source.replace(/\.(typ|tex)$/i, ".pdf");
  return files.has(pdf) ? pdf : null;
}

export function Tracker() {
  const { data, error, reload } = useFetch<{ exists: boolean; header: string[]; rows: Row[] }>("/api/tracker");
  const files = useFetch<FileEntry[]>("/api/files");
  const [showClosed, setShowClosed] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const fileSet = new Set((files.data ?? []).map((f) => f.path));

  const rows = (data?.rows ?? []).map((r, i) => ({ r, i })).filter(({ r }) => showClosed || r._open === "1").reverse();

  return (
    <div className="stack">
      <h1>지원 현황</h1>
      <ErrorBox error={error} />
      <Card
        title={`지원 ${data?.rows.length ?? 0}건`}
        actions={
          <>
            <label className="row small">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> 종료된 지원 포함
            </label>
            <CommandButton prompt="/outcome" label="결과 기록" />
            <CommandButton prompt="/outcome followup" label="후속 연락" />
            <button className="btn secondary" onClick={reload}>새로고침</button>
          </>
        }
      >
        {data && !data.exists ? (
          <p className="muted">job_search_tracker.csv가 아직 없습니다. /apply로 첫 지원서를 만들면 생깁니다.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>날짜</th>
                <th>회사</th>
                <th>직무</th>
                <th>상태</th>
                <th>적합도</th>
                <th>마감</th>
                <th>서류</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ r, i }) => {
                const cv = pdfFor(r.cv_file, fileSet);
                const cover = pdfFor(r.cover_letter_file, fileSet);
                const source = safeHttpUrl(r.source);
                return (
                  <Fragment key={i}>
                    <tr className="clickable" onClick={() => setOpen(open === i ? null : i)}>
                      <td>{r.date}</td>
                      <td>{r.company}</td>
                      <td>{r.role}</td>
                      <td><StatusChip status={r.status} /></td>
                      <td>{r.fit_rating}</td>
                      <td><Deadline date={r.deadline} /></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {cv && <a href={fileUrl(cv)} target="_blank" rel="noopener noreferrer">CV</a>}{" "}
                        {cover && <a href={fileUrl(cover)} target="_blank" rel="noopener noreferrer">커버레터</a>}
                      </td>
                    </tr>
                    {open === i && (
                      <tr className="detail">
                        <td colSpan={7}>
                          <div className="stack">
                            {r.notes && <div><b>메모</b> {r.notes}</div>}
                            {r.contact_person && <div><b>담당자</b> {r.contact_person}</div>}
                            {r.channel && <div><b>지원 경로</b> {r.channel}</div>}
                            {source && <div><b>공고</b> <a href={source} target="_blank" rel="noopener noreferrer">{source}</a></div>}
                            <div className="row wrap">
                              <CommandButton prompt={`/outcome ${r.company} ${r.role}`} label="결과 기록" />
                              <CommandButton prompt={`/interview ${r.company} ${r.role}`} label="면접 준비" />
                              <CommandButton prompt={`/outcome followup ${r.company} ${r.role}`} label="후속 메일 초안" />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
