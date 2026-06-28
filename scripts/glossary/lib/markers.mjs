// コード内の `@term:` マーカーを解析する。依存ゼロ。
//
// マーカーは「ある用語に紐づくコード領域(ガード範囲)」を宣言する。
// staleness チェック(コードを直したら用語を再検証させる)の *精密な* 紐付けはこれで行う。
// frontmatter の code_refs は「ナビゲーション+存在検証」用で、staleness の判定には使わない。
//   - 大きいファイル(例: content-script.js 4000 行)で file 単位の紐付けにすると
//     無関係な変更まで用語更新を要求してしまい、結果的にゲートがバイパスされる。
//   - そこでマーカー行から「次の @term:/@endterm: 行 or EOF」までを *ガード範囲* とし、
//     変更行がその範囲に重なった時だけ、その用語の再検証を要求する。
//
// 形式(コメント記号は問わない。行内に下記が現れれば良い):
//   @term: <id>        … 以降をその用語のガード範囲として開始
//   @endterm           … 直近のガード範囲を明示終了(任意)
//   @endterm: <id>     … id 指定で終了(任意)
// <id> は ^[a-z0-9][a-z0-9-]*$ (用語 id と同じ規約)。

export const TERM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TERM_RE = /@term:\s*([^\s*]+)/;
const ENDTERM_RE = /@endterm(?::\s*([^\s*]+))?/;

// 返り値: { markers: [{id, startLine, endLine, lineText}], errors: [{line, message}] }
// startLine/endLine は 1 始まり。endLine は範囲の最終行(次マーカー/endterm の手前 or EOF)。
export function parseMarkers(text) {
  const lines = text.split(/\r?\n/);
  const markers = [];
  const errors = [];
  let open = null; // 現在開いているマーカー

  const closeAt = (lineNo) => {
    if (open) {
      open.endLine = lineNo;
      markers.push(open);
      open = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const endM = ENDTERM_RE.exec(line);
    const m = TERM_RE.exec(line);
    if (m) {
      // 新しいマーカー開始。直前のマーカーは前行で閉じる。
      closeAt(lineNo - 1);
      const id = m[1];
      if (!TERM_ID_RE.test(id)) {
        errors.push({ line: lineNo, message: `@term の id 形式違反 "${id}" (規約 ${TERM_ID_RE})` });
      }
      open = { id, startLine: lineNo, endLine: lines.length, lineText: line.trim() };
      continue;
    }
    if (endM) {
      if (!open) {
        errors.push({ line: lineNo, message: '@endterm に対応する @term がありません' });
      } else if (endM[1] && endM[1] !== open.id) {
        errors.push({ line: lineNo, message: `@endterm の id "${endM[1]}" が直近の @term "${open.id}" と一致しません` });
      }
      closeAt(lineNo);
    }
  }
  closeAt(lines.length);
  return { markers, errors };
}

// 変更行範囲(new 側) [start,end] の集合が、いずれかのマーカーのガード範囲に重なるか。
// 重なった用語 id の集合を返す。
export function termsTouchedByRanges(markers, ranges) {
  const hit = new Set();
  for (const m of markers) {
    for (const r of ranges) {
      if (r.start <= m.endLine && r.end >= m.startLine) {
        hit.add(m.id);
        break;
      }
    }
  }
  return hit;
}
