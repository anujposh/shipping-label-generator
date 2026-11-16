import zlib from "node:zlib";

import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";

import { log } from "../core/logger";
import { docTabPdfPositions } from "./doc-tab-layout";

/**
 * Label PDF size normalization — carrier PDF labels arrive on the carrier's
 * own sheet geometry, not the selected label stock. FedEx PDF labels (the
 * shipping-cli parity shape: labelSpecification carries imageType only)
 * always come back as ONE landscape letter page (792x612pt) regardless of
 * the requested size: the actual label block sits in the left column and
 * the rest of the page carries folding instructions + terms panels
 * (verified live against apis-sandbox.fedex.com AND production — see
 * tests/fixtures/labels/fedex-sandbox-*.pdf and
 * .omo/evidence/bc-laravel-parity-web-fixes/live-label-samples/). Streaming
 * that page straight into the preview shows a letter PDF with the label
 * tucked in the corner — the "preview shows a PDF page instead of the
 * label" defect.
 *
 * cropLabelPdfToSize() rewrites the page boxes so the page IS the label:
 *
 * 1. Parse the page's content stream (pure Node: Flate/ASCII85 filters,
 *    no native deps) and compute the ink bounding box with CTM-aware
 *    operator tracking (re / m / l / c / v / y paths, cm+Do image and form
 *    placements, BT/ET text with Tm/Td/Tf/Tz/Tj/TJ and a conservative
 *    monospaced width estimate).
 * 2. Split the ink into columns at horizontal gaps >= GAP_SPLIT_PT and
 *    keep the LEFTMOST cluster — on FedEx letter sheets that is the label
 *    column; the fold rule, folding instructions and T&C panels live to
 *    its right. When there is no such gap the whole ink box is the label
 *    (thermal-size sheets, other carriers).
 * 3. Snap to the EXACT selected label size (points) when the label block
 *    fills >= SNAP_FILL_MIN of the stock in both dimensions (a genuine
 *    4x6 label block on a letter sheet snaps to 288x432); otherwise crop
 *    honestly to the padded ink box — never fake whitespace to stretch a
 *    label onto stock it does not match.
 * 4. pdf-lib (pure JS) rewrites MediaBox/CropBox/TrimBox/BleedBox in
 *    place; content streams and XObjects are untouched, so the barcode,
 *    addresses and rules survive byte-for-byte.
 *
 * EVERY failure path returns the original bytes: cropping is an
 * enhancement, never a label-flow risk. Already-correct pages (UPS
 * thermal PDFs are exact 288x432) short-circuit to the original buffer.
 */

/** Selected label size (wire string) -> exact stock size in PDF points. */
export const LABEL_SIZE_POINTS: Record<string, { w: number; h: number }> = {
  "4 X 6": { w: 288, h: 432 },
  "4 X 675": { w: 288, h: 486 },
  "8/5 X 11": { w: 612, h: 792 },
  "4/8 X 9/2": { w: 297, h: 684 },
};

/**
 * Label sizes whose cropped page MUST measure the exact stock — the
 * 4x6.75 doc-tab roll. FedEx REJECTS doc-tab labelStockType on PDF labels
 * (INVALID.STOCK.TYPE, live sandbox probe 2026-10-05), so PDF labels come
 * back as letter sheets whose ~4x6 ink block underfills the 6.75" stock;
 * the strict snap still lands the page on exactly 288x486pt and the doc
 * tab strip itself is composed locally (composeDocTabLabelPdf).
 */
const STRICT_STOCK_SIZES: ReadonlySet<string> = new Set(["4 X 675"]);

/** Horizontal gap (pt) splitting the label column from side panels. */
const GAP_SPLIT_PT = 30;
/** Label must fill this fraction of the selected stock in BOTH dimensions
 * for the snap-to-exact-size path (avoids stretching a 4x6 label onto
 * letter/doc-tab stock with fake whitespace). */
const SNAP_FILL_MIN = 0.88;
/** Whitespace kept around the ink when cropping (pt). */
const INK_PAD_PT = 2;
/** Boxes within this distance (pt) count as "already this size". */
const SAME_BOX_PT = 2;
/** Conservative glyph metrics for the text width estimate. */
const GLYPH_WIDTH_RATIO = 0.6;
const ASCENDER_RATIO = 0.8;
const DESCENDER_RATIO = 0.25;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Adobe ASCII85 (no <~ wrapper requirement, 'z' shortcut, ~>/~ end). */
function ascii85Decode(data: Buffer): Buffer | null {
  const out: number[] = [];
  let group: number[] = [];
  const pushGroup = (): void => {
    if (group.length === 0) return;
    const padded = [...group];
    while (padded.length < 5) padded.push(85 - 1); // 'u' padding
    const n =
      ((((padded[0] * 85 + padded[1]) * 85 + padded[2]) * 85 + padded[3]) * 85 +
        padded[4]) >>>
      0;
    const bytes = [
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ];
    out.push(...bytes.slice(0, group.length - 1));
    group = [];
  };
  for (const byte of data) {
    const ch = String.fromCharCode(byte);
    if (/\s/.test(ch)) continue;
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (ch === "~") {
      pushGroup();
      break;
    }
    const code = ch.charCodeAt(0);
    if (code < 33 || code > 117) return null;
    group.push(code - 33);
    if (group.length === 5) pushGroup();
  }
  if (group.length > 0) pushGroup();
  return Buffer.from(out);
}

function decodeStream(dict: string, data: Buffer): Buffer | null {
  try {
    let out = data;
    if (/ASCII85Decode/.test(dict)) {
      const decoded = ascii85Decode(out);
      if (!decoded) return null;
      out = decoded;
    }
    if (/FlateDecode/.test(dict)) {
      out = zlib.inflateSync(out);
    }
    return out;
  } catch {
    return null;
  }
}

interface RawStream {
  id: number;
  dict: string;
  data: Buffer;
}

/** All `N 0 obj <<dict>> stream..endstream` objects in the raw bytes. */
function findStreams(pdf: Buffer): RawStream[] {
  const latin = pdf.toString("latin1");
  const streams: RawStream[] = [];
  const re = /(\d+)\s+0\s+obj\s*<<(.*?)>>\s*stream\r?\n?/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;
    streams.push({
      id: Number(m[1]),
      dict: m[2],
      data: pdf.subarray(start, end),
    });
  }
  return streams;
}

/** Content streams of the (single) page: via /Contents refs when parseable,
 * else any decoded stream that looks like a drawing program. */
function pageContentStreams(pdf: Buffer, streams: RawStream[]): Buffer[] {
  const latin = pdf.toString("latin1");
  const contents: Buffer[] = [];
  // Object-body chunks: text between "N 0 obj" and stream/endobj markers,
  // so a lazy regex can never run across object boundaries.
  const refRe =
    /\/Contents\s*((?:\[\s*\d+\s+0\s+R(?:\s*\d+\s+0\s+R)*\s*\])|\d+\s+0\s+R)/;
  for (const chunk of latin.split(/(?:\d+)\s+0\s+obj/).slice(1)) {
    const body = chunk.split(/stream\r?\n|endobj/)[0];
    if (!/\/Type\s*\/Page[\s/>]/.test(body)) continue;
    const rr = refRe.exec(body);
    if (!rr) continue;
    for (const idStr of rr[1].matchAll(/\d+/g)) {
      const stream = streams.find((s) => s.id === Number(idStr));
      if (!stream) continue;
      const decoded = decodeStream(stream.dict, stream.data);
      if (decoded) contents.push(decoded);
    }
  }
  if (contents.length > 0) return contents;
  // Fallback: any stream decoding to something operator-shaped.
  return streams
    .map((s) => decodeStream(s.dict, s.data))
    .filter(
      (data): data is Buffer =>
        data != null &&
        /\bre\b/.test(String(data.subarray(0, 4096))) &&
        /\bTj\b|\bTm\b|\bcm\b|\bDo\b/.test(String(data.subarray(0, 4096))),
    );
}

/** Track operand numbers between operators (token-level, string-aware). */
function computeInkSpans(content: Buffer): Box[] {
  const tokens = content.toString("latin1").split(/\s+/);
  const spans: Box[] = [];
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let fontSize = 0;
  let hScale = 100;
  let leading = 0;
  let nums: number[] = [];
  let arrayBuf: string[] = [];
  let arrayDepth = 0;
  let inInlineImage = false;
  let lastToken = "";

  const expand = (box: Box): void => {
    spans.push(box);
  };
  const spanFromPoints = (pts: Array<[number, number]>): void => {
    const page = pts.map(([x, y]) => apply(ctm, x, y));
    expand({
      x0: Math.min(...page.map((p) => p[0])),
      y0: Math.min(...page.map((p) => p[1])),
      x1: Math.max(...page.map((p) => p[0])),
      y1: Math.max(...page.map((p) => p[1])),
    });
  };
  const textSpan = (source: string): void => {
    const literal = Array.from(source.matchAll(/\((.*?)\)/g))
      .map((mm) => mm[1])
      .join("");
    const width =
      literal.length * fontSize * GLYPH_WIDTH_RATIO * (hScale / 100);
    const down = fontSize * DESCENDER_RATIO;
    const up = fontSize * ASCENDER_RATIO;
    const pts: Array<[number, number]> = (
      [
        [0, 0],
        [width, 0],
        [0, up],
        [width, up],
        [0, -down],
        [width, -down],
      ] as Array<[number, number]>
    ).map((p) => apply(tm, p[0], p[1]));
    spans.push({
      x0: Math.min(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])),
      x1: Math.max(...pts.map((p) => p[0])),
      y1: Math.max(...pts.map((p) => p[1])),
    });
  };

  for (const token of tokens) {
    if (token === "") continue;
    if (inInlineImage) {
      if (token === "EI") inInlineImage = false;
      continue;
    }
    const asNum = Number(token);
    if (
      token !== "" &&
      !Number.isNaN(asNum) &&
      /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(token)
    ) {
      if (arrayDepth > 0) arrayBuf.push(token);
      else nums.push(asNum);
      continue;
    }
    switch (token) {
      case "BI":
        inInlineImage = true;
        nums = [];
        break;
      case "[":
        arrayDepth += 1;
        arrayBuf = [];
        break;
      case "]":
        arrayDepth = Math.max(0, arrayDepth - 1);
        break;
      case "q":
        ctmStack.push(ctm);
        nums = [];
        break;
      case "Q":
        ctm = ctmStack.pop() ?? ctm;
        nums = [];
        break;
      case "cm":
        if (nums.length >= 6) ctm = mul(nums.slice(-6) as Matrix, ctm);
        nums = [];
        break;
      case "re":
        if (nums.length >= 4) {
          const [x, y, w, h] = nums.slice(-4);
          spanFromPoints([
            [x, y],
            [x + w, y],
            [x, y + h],
            [x + w, y + h],
          ]);
        }
        nums = [];
        break;
      case "m":
      case "l":
        if (nums.length >= 2) {
          const [x, y] = nums.slice(-2);
          spanFromPoints([[x, y]]);
        }
        nums = [];
        break;
      case "c":
      case "v":
      case "y":
        if (nums.length >= 6) {
          const six = nums.slice(-6);
          const pts: Array<[number, number]> = [];
          for (let j = 0; j < 6; j += 2) pts.push([six[j], six[j + 1]]);
          spanFromPoints(pts);
        }
        nums = [];
        break;
      case "Do": {
        spanFromPoints([
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]);
        nums = [];
        break;
      }
      case "BT":
        tm = IDENTITY;
        nums = [];
        break;
      case "ET":
        nums = [];
        break;
      case "Tm":
        if (nums.length >= 6) tm = nums.slice(-6) as Matrix;
        nums = [];
        break;
      case "Tf":
        if (nums.length >= 2) fontSize = nums[nums.length - 1];
        nums = [];
        break;
      case "Tz":
        if (nums.length >= 1) hScale = nums[nums.length - 1];
        nums = [];
        break;
      case "TL":
        if (nums.length >= 1) leading = nums[nums.length - 1];
        nums = [];
        break;
      case "Td":
      case "TD":
        if (nums.length >= 2) {
          const [tx, ty] = nums.slice(-2);
          tm = mul([1, 0, 0, 1, tx, ty], tm);
          if (token === "TD") leading = -ty;
        }
        nums = [];
        break;
      case "T*":
        tm = mul([1, 0, 0, 1, 0, -leading], tm);
        nums = [];
        break;
      case "Tj":
      case "TJ":
      case "'":
      case '"': {
        if (token === "'" || token === '"') {
          tm = mul([1, 0, 0, 1, 0, -leading], tm);
        }
        const source = arrayBuf.length > 0 ? arrayBuf.join(" ") : lastToken;
        textSpan(source);
        arrayBuf = [];
        arrayDepth = 0;
        nums = [];
        break;
      }
      default:
        // Color, graphics state, and other no-geometry operators clear
        // pending operands (their args are names or numbers we ignore).
        if (arrayDepth === 0) nums = [];
        break;
    }
    lastToken = token;
  }
  return spans;
}

/** Merge x-spans and return the x cutoff ending the LEFTMOST cluster. */
function leftmostClusterCutoff(spans: Box[]): number | null {
  if (spans.length === 0) return null;
  const intervals = spans
    .map((s) => [s.x0, s.x1] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let clusterEnd = intervals[0][1];
  for (let i = 1; i < intervals.length; i += 1) {
    const [start, end] = intervals[i];
    if (start - clusterEnd >= GAP_SPLIT_PT) {
      // First qualifying gap — the label column ends at clusterEnd.
      return clusterEnd;
    }
    clusterEnd = Math.max(clusterEnd, end);
  }
  return null; // no gap: single cluster, keep everything
}

function cropBox(
  spans: Box[],
  page: { x: number; y: number; width: number; height: number },
  target: { w: number; h: number },
  strict = false,
): Box | null {
  const cutoff = leftmostClusterCutoff(spans);
  const labelSpans =
    cutoff == null ? spans : spans.filter((s) => s.x0 <= cutoff + 1);
  const use = labelSpans.length > 0 ? labelSpans : spans;
  if (use.length === 0) return null;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of use) {
    x0 = Math.min(x0, s.x0);
    y0 = Math.min(y0, s.y0);
    x1 = Math.max(x1, s.x1);
    y1 = Math.max(y1, s.y1);
  }
  x0 -= INK_PAD_PT;
  y0 -= INK_PAD_PT;
  x1 += INK_PAD_PT;
  y1 += INK_PAD_PT;

  const inkW = x1 - x0;
  const inkH = y1 - y0;
  if (!(inkW > 10 && inkH > 10)) return null;

  // Orientation-agnostic stock match: carrier label blocks may be drawn
  // rotated on the sheet (FedEx letter labels carry /Rotate 90 — a "4 X 6"
  // label block is landscape as displayed), so either aspect of the
  // selected stock is an exact-size match.
  const orientations =
    target.w === target.h ? [target] : [target, { w: target.h, h: target.w }];
  let snap: { w: number; h: number } | null = null;
  for (const stock of orientations) {
    const fillW = inkW / stock.w;
    const fillH = inkH / stock.h;
    if (
      fillW <= 1.02 &&
      fillH <= 1.02 &&
      (strict || (fillW >= SNAP_FILL_MIN && fillH >= SNAP_FILL_MIN))
    ) {
      snap = stock;
      break;
    }
  }
  if (snap && (snap.w > page.width + 1 || snap.h > page.height + 1)) {
    snap = null; // stock cannot fit on the physical page — honest crop
  }

  let box: Box;
  if (snap) {
    // Exact selected stock, centered on the label, clamped to the page.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let bx = cx - snap.w / 2;
    let by = cy - snap.h / 2;
    bx = Math.min(Math.max(bx, page.x), page.x + page.width - snap.w);
    by = Math.min(Math.max(by, page.y), page.y + page.height - snap.h);
    box = { x0: bx, y0: by, x1: bx + snap.w, y1: by + snap.h };
  } else {
    box = {
      x0: Math.max(x0, page.x),
      y0: Math.max(y0, page.y),
      x1: Math.min(x1, page.x + page.width),
      y1: Math.min(y1, page.y + page.height),
    };
  }
  return box;
}

/**
 * Crop a carrier label PDF page to the selected label size. Returns the
 * ORIGINAL bytes on any parse failure, multi-page/rotated documents,
 * unknown sizes, or pages already at the target geometry.
 */
export async function cropLabelPdfToSize(
  pdf: Buffer,
  labelSize: string | null | undefined,
): Promise<Buffer> {
  const target = labelSize != null ? LABEL_SIZE_POINTS[labelSize] : undefined;
  if (!target || pdf.length < 64) return pdf;
  try {
    const doc = await PDFDocument.load(pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (doc.getPageCount() !== 1) return pdf;
    const page = doc.getPage(0);
    const media = page.getMediaBox();
    const rotation = page.getRotation().angle % 360;
    if (
      Math.abs(media.width - target.w) <= SAME_BOX_PT &&
      Math.abs(media.height - target.h) <= SAME_BOX_PT
    ) {
      if (rotation === 0) return pdf; // already exact AND upright (UPS thermal)
      // Exact-size but rotated page (labels stored by the pre-rotation-fix
      // crop): carrier label text is authored upright in content space, so
      // normalizing to /Rotate 0 heals the sideways display.
      page.setRotation(degrees(0));
      return Buffer.from(await doc.save({ useObjectStreams: false }));
    }

    const streams = findStreams(pdf);
    const contents = pageContentStreams(pdf, streams);
    if (contents.length === 0) return pdf;
    const spans = contents.flatMap((content) => computeInkSpans(content));
    const box = cropBox(
      spans,
      media,
      target,
      STRICT_STOCK_SIZES.has(labelSize ?? ""),
    );
    if (!box) return pdf;

    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    if (
      rotation === 0 &&
      Math.abs(w - media.width) <= SAME_BOX_PT &&
      Math.abs(h - media.height) <= SAME_BOX_PT
    ) {
      return pdf; // crop would be a no-op on an already-upright page
    }

    page.setMediaBox(box.x0, box.y0, w, h);
    page.setCropBox(box.x0, box.y0, w, h);
    page.setTrimBox(box.x0, box.y0, w, h);
    page.setBleedBox(box.x0, box.y0, w, h);
    // The crop box lives in CONTENT space, where carrier label text is
    // authored upright (FedEx letter sheets carry /Rotate 90 to lay the
    // label sideways on the sheet for folding). Normalizing rotation to 0
    // makes the cropped page display the label upright at stock size —
    // verified against Chrome PDFium and MuPDF renderings of sandbox labels.
    page.setRotation(degrees(0));
    // Plain (non-object-stream) serialization keeps the PDF readable by
    // simple downstream consumers and re-crop passes.
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  } catch (error) {
    log("warn", "label_pdf_crop_skipped", {
      labelSize: String(labelSize),
      reason: error instanceof Error ? error.message : String(error),
    });
    return pdf;
  }
}

/**
 * CSS `aspect-ratio` ("w / h") of the label page as DISPLAYED — the size
 * the preview frame should take. Runs the same crop the serve path applies
 * so the ratio always matches the bytes the browser receives. Returns null
 * when the bytes are not a single-page PDF.
 */
export async function labelPdfAspect(
  pdf: Buffer,
  labelSize: string | null | undefined,
): Promise<string | null> {
  try {
    const sized = labelSize ? await cropLabelPdfToSize(pdf, labelSize) : pdf;
    if (sized.length < 64) return null;
    const doc = await PDFDocument.load(sized, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (doc.getPageCount() !== 1) return null;
    const page = doc.getPage(0);
    const { width, height } = page.getMediaBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const displayWidth = swap ? height : width;
    const displayHeight = swap ? width : height;
    if (!(displayWidth > 1 && displayHeight > 1)) return null;
    const fmt = (n: number): string =>
      Math.abs(n - Math.round(n)) < 0.01 ? String(Math.round(n)) : n.toFixed(1);
    return `${fmt(displayWidth)} / ${fmt(displayHeight)}`;
  } catch {
    return null;
  }
}

export interface DocTabStripZone {
  header: string;
  value: string;
}

const DOC_TAB_STOCK = LABEL_SIZE_POINTS["4 X 675"];
const DOC_TAB_LABEL = LABEL_SIZE_POINTS["4 X 6"];

/**
 * Compose the FedEx 4x6.75 doc-tab label as a PDF: exact 288x486pt page
 * carrying the carrier's 4x6 label block plus a locally drawn leading
 * doc-tab strip (FedEx renders doc tabs only on ZPL — INVALID.STOCK.TYPE
 * on PDF, live probe 2026-10-05). Returns the ORIGINAL bytes whenever the
 * input is not a single-page PDF that crops to a clean 4x6 label block,
 * or is already at the exact 4x6.75 stock.
 */
export async function composeDocTabLabelPdf(
  pdf: Buffer,
  zones: DocTabStripZone[],
): Promise<Buffer> {
  if (pdf.length < 64 || zones.length === 0) return pdf;
  try {
    const probe = await PDFDocument.load(pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (probe.getPageCount() !== 1) return pdf;
    const probePage = probe.getPage(0);
    const probeBox = probePage.getMediaBox();
    const probeRotation = ((probePage.getRotation().angle % 360) + 360) % 360;
    const probeSwap = probeRotation === 90 || probeRotation === 270;
    const displayW = probeSwap ? probeBox.height : probeBox.width;
    const displayH = probeSwap ? probeBox.width : probeBox.height;
    if (
      Math.abs(displayW - DOC_TAB_STOCK.w) <= SAME_BOX_PT &&
      Math.abs(displayH - DOC_TAB_STOCK.h) <= SAME_BOX_PT
    ) {
      return pdf;
    }

    const labelBytes = await cropLabelPdfToSize(pdf, "4 X 6");
    const labelDoc = await PDFDocument.load(labelBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (labelDoc.getPageCount() !== 1) return pdf;
    const labelBox = labelDoc.getPage(0).getMediaBox();
    if (
      Math.abs(labelBox.width - DOC_TAB_LABEL.w) > SAME_BOX_PT ||
      Math.abs(labelBox.height - DOC_TAB_LABEL.h) > SAME_BOX_PT
    ) {
      return pdf;
    }

    const out = await PDFDocument.create();
    const page = out.addPage([DOC_TAB_STOCK.w, DOC_TAB_STOCK.h]);
    page.setRotation(degrees(0));
    const embedded = await out.embedPage(labelDoc.getPage(0), {
      left: labelBox.x,
      bottom: labelBox.y,
      right: labelBox.x + labelBox.width,
      top: labelBox.y + labelBox.height,
    });
    page.drawPage(embedded, {
      x: 0,
      y: 0,
      width: DOC_TAB_LABEL.w,
      height: DOC_TAB_LABEL.h,
    });

    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const regular = await out.embedFont(StandardFonts.Helvetica);

    page.drawLine({
      start: { x: 2, y: DOC_TAB_LABEL.h + 1.5 },
      end: { x: DOC_TAB_STOCK.w - 2, y: DOC_TAB_LABEL.h + 1.5 },
      thickness: 0.4,
      color: rgb(0, 0, 0),
      dashArray: [2, 2],
    });

    // BC 3×4 grid — same positional layout as the ZPL doc tab
    // (doc-tab-layout.ts): 3 columns × 4 rows of "Header: value" fields.
    const fontSize = 7;
    const baselineDrop = 3.5; // keep glyphs below the row's ZPL origin
    const positions = docTabPdfPositions(DOC_TAB_STOCK);
    const columnX = positions.map((pos) => pos.x);
    zones.slice(0, positions.length).forEach((zone, index) => {
      const { x, y } = positions[index];
      const header = `${zone.header}:`;
      page.drawText(header, {
        x,
        y: y - baselineDrop,
        size: fontSize,
        font: bold,
        color: rgb(0, 0, 0),
      });
      if (zone.value.length === 0) return;
      const valueX = x + bold.widthOfTextAtSize(header, fontSize) + 2;
      const nextColumn = columnX.find((cx) => cx > x);
      const available = (nextColumn ?? DOC_TAB_STOCK.w - 2) - valueX - 2;
      let value = zone.value;
      while (
        value.length > 1 &&
        regular.widthOfTextAtSize(value, fontSize) > available
      ) {
        value =
          value.length > 4
            ? `${value.slice(0, value.length - 4)}...`
            : value.slice(0, 1);
      }
      page.drawText(value, {
        x: valueX,
        y: y - baselineDrop,
        size: fontSize,
        font: regular,
        color: rgb(0, 0, 0),
      });
    });

    return Buffer.from(await out.save({ useObjectStreams: false }));
  } catch (error) {
    log("warn", "label_doc_tab_compose_skipped", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return pdf;
  }
}
