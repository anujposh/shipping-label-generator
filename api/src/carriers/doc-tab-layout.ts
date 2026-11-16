/**
 * BC doc-tab grid — the single source of truth for the 3-column × 4-row
 * positional layout used by the actual BC/FedEx label (reference label
 * shipping-label-SH051530-64). Both label surfaces derive their positions
 * from these constants so the ZPL wire content and the locally composed
 * PDF preview can never drift apart:
 *
 *   - ZPL: applyDocTabZones() rewrites the doc-tab field block FedEx
 *     rendered (ZONE001 server-side rendering is data-driven and lays
 *     zones out at its own discretion — live probes show it skipping
 *     empty zones and using its own short headers) into the exact BC
 *     grid with BC headers and BC-formatted values.
 *   - PDF: docTabPdfPositions() maps the same ZPL dot coordinates onto
 *     the 288x486pt composed page for composeDocTabLabelPdf().
 *
 * Grid (ZPL dots on the 4x6.75 doc-tab stock @ 8 dots/mm):
 *
 *   Column 1 ^FO10    Column 2 ^FO270   Column 3 ^FO540
 *   Row 1 ^FO<x>,8    REF                Date               Shipping
 *   Row 2 ^FO<x>,30   Phone              Weight             Special
 *   Row 3 ^FO<x>,52   P.O                COD                Handling
 *   Row 4 ^FO<x>,73   PckgTyp            DV                 Total
 */

/** Column X coordinates (ZPL dots) — exactly three columns, no more. */
export const DOC_TAB_COLUMNS_X = [10, 270, 540] as const;

/** Row Y coordinates (ZPL dots) — exactly four rows, no more. */
export const DOC_TAB_ROWS_Y = [8, 30, 52, 73] as const;

/** 3 columns × 4 rows — the BC label carries exactly 12 doc-tab fields. */
export const DOC_TAB_FIELD_COUNT =
  DOC_TAB_COLUMNS_X.length * DOC_TAB_ROWS_Y.length;

/** ZPL stock geometry of STOCK_4X675_LEADING_DOC_TAB @ 8 dots/mm
 * (4in = 812.8 ≈ 812 dots wide, 6.75in = 1371.6 ≈ 1372 dots tall). */
const ZPL_STOCK_WIDTH_DOTS = 812;
const ZPL_STOCK_HEIGHT_DOTS = 1372;

/** Label-home Y offset (^LH0,20) present in EVERY live FedEx doc-tab ZPL
 * capture (doctab-probe/zpl-nodot.zpl, doctab-grid/live-zpl-4675.zpl,
 * shipping-parity-20261005 raw-zpl-A-current-spec.zpl + raw-zpl-B-bc-spec.zpl
 * + live-zpl-4675-postfix.zpl): the ZPL renderer shifts every field 20 dots
 * (7.1pt at 486pt stock height) down from its ^FO origin. The printed ZPL
 * surface gets this for free from FedEx's own ^LH command — the PDF strip
 * mapping must apply it explicitly or the preview pins the grid to the page
 * top instead of the rendered position (BC reference rows sit at
 * (8/30/52/73 + 20) dots = 9.9/17.7/25.5/33.0pt from the top of a 288x486
 * page; FedEx's own native tab fields ^FO10,8/^FO270,30/^FO10,73 render at
 * 28/50/93 dots the same way). */
export const ZPL_LABEL_HOME_Y_DOTS = 20;

export interface DocTabStripField {
  header: string;
  value: string;
}

/** Zone index (0-based, BC order) -> grid slot (column, row). */
export function docTabGridSlot(index: number): {
  col: number;
  row: number;
} {
  if (!Number.isInteger(index) || index < 0 || index >= DOC_TAB_FIELD_COUNT) {
    throw new RangeError(`doc tab zone index out of range: ${index}`);
  }
  return {
    col: Math.floor(index / DOC_TAB_ROWS_Y.length),
    row: index % DOC_TAB_ROWS_Y.length,
  };
}

/**
 * ^FH hex escape for doc-tab field text: with field-hex encoding active,
 * '_' is the hex indirection character, so a literal underscore must be
 * written as "_5F" (FedEx native rendering does the same — live probe
 * shows "YOUR_5FPACKAGING" on the wire doc tab).
 */
function escapeDocTabFieldText(text: string): string {
  return text.replace(/_/g, "_5F");
}

/**
 * One doc-tab field line, e.g.
 * ^FO10,8^AdN,0,0^FWN^FH^FDREF: SO43497^FS
 * Empty values render as the bare header ("^FDCOD:^FS") — the reference
 * label shows COD:/DV:/Shipping:/Special:/Handling:/Total: with no value.
 */
export function docTabZplField(
  index: number,
  header: string,
  value: string,
): string {
  const { col, row } = docTabGridSlot(index);
  const text = value.length > 0 ? `${header}: ${value}` : `${header}:`;
  return `^FO${DOC_TAB_COLUMNS_X[col]},${DOC_TAB_ROWS_Y[row]}^AdN,0,0^FWN^FH^FD${escapeDocTabFieldText(text)}^FS`;
}

/** A FedEx-rendered doc-tab field in returned ZPL: font D (^Ad) at any
 * coordinate. Coordinate-captured (not just font-matched): the strip is
 * bounded to the doc-tab band below, because the main label body ALSO
 * renders font-D fields (FROM block, SHIP DATE/ACTWGT/CAD/BILL SENDER,
 * recipient phone) — a font-only match would delete the label body. */
const FEDEX_DOC_TAB_FIELD =
  /\^FO(\d+),(\d+)\^AdN,\d+,\d+(?:\^FW[NBR])?(?:\^FH)?\^FD[\s\S]*?\^FS/g;

/** Doc-tab fields live in the top band of the label only. Live captures
 * (.omo/evidence/doctab-probe/zpl-nodot.zpl, doctab-grid/live-zpl-4675.zpl):
 * FedEx-rendered tab fields sit at y ≤ ~84 dots (the BC grid rows are
 * 8/30/52/73; FedEx partial renders stay under ~84), while the body's
 * font-D fields start at y = 165 (FROM: at ^FO32,165) and FedEx's tab
 * defaults TRCK/Svcs use font ^A0 at y 109/129 (never matched above).
 * 100 sits squarely in the evidenced gap. */
const DOC_TAB_STRIP_MAX_Y_DOTS = 100;

/**
 * Normalize a FedEx ZPL label's doc tab to the exact BC 3×4 grid:
 *
 *  1. strip every FedEx-rendered doc-tab field — font-D fields whose ^FO
 *     y coordinate lies inside the doc-tab band (see above) — whatever
 *     layout FedEx chose, including partial renders that skip empty
 *     zones, and
 *  2. emit exactly 12 canonical fields at the grid coordinates, BC
 *     headers, BC-formatted values, inserted before ^PQ (or ^XZ when
 *     the label carries no print-quantity command).
 *
 * Non-ZPL bytes are returned untouched (safety: never corrupt a label
 * we do not recognize).
 */
export function applyDocTabZones(
  zpl: string,
  zones: ReadonlyArray<DocTabStripField>,
): string {
  if (!/\^FS/.test(zpl)) return zpl;
  const fields = zones
    .slice(0, DOC_TAB_FIELD_COUNT)
    .map((zone, index) => docTabZplField(index, zone.header, zone.value));
  const block = fields.join("\n");
  const stripped = zpl.replace(FEDEX_DOC_TAB_FIELD, (field, _x, y) =>
    Number(y) <= DOC_TAB_STRIP_MAX_Y_DOTS ? "" : field,
  );
  const pqIndex = stripped.indexOf("^PQ");
  if (pqIndex !== -1) {
    return `${stripped.slice(0, pqIndex)}${block}\n${stripped.slice(pqIndex)}`;
  }
  const xzIndex = stripped.lastIndexOf("^XZ");
  if (xzIndex !== -1) {
    return `${stripped.slice(0, xzIndex)}${block}\n${stripped.slice(xzIndex)}`;
  }
  return `${stripped}\n${block}\n`;
}

function roundTo1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * PDF point positions mirroring the ZPL grid on the composed 4x6.75 page
 * (e.g. 288x486pt). Each entry is the ZPL-proportional field origin
 * (column X, row top incl. the ^LH0,20 label-home shift, matching how the
 * ZPL actually renders) for the zone at that index — draw text with its
 * BASELINE a few points below the returned y so glyphs stay inside the
 * strip. Computed by scaling ZPL stock dots to the PDF stock size.
 */
export function docTabPdfPositions(stock: {
  w: number;
  h: number;
}): Array<{ x: number; y: number }> {
  return Array.from({ length: DOC_TAB_FIELD_COUNT }, (_, index) => {
    const { col, row } = docTabGridSlot(index);
    return {
      x: roundTo1((stock.w * DOC_TAB_COLUMNS_X[col]) / ZPL_STOCK_WIDTH_DOTS),
      y: roundTo1(
        stock.h -
          (stock.h * (DOC_TAB_ROWS_Y[row] + ZPL_LABEL_HOME_Y_DOTS)) /
            ZPL_STOCK_HEIGHT_DOTS,
      ),
    };
  });
}
