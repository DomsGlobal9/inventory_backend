/**
 * The Day Book PDF, made on the server for the nightly WhatsApp send.
 *
 * A COPY of frontend/src/components/DayBookPDF.jsx, element for element, with the same library
 * (@react-pdf/renderer) and the same styles, so the PDF an owner gets at 10 pm is the one they
 * would download from the Day Book page. It is a copy because the two live in separate repos and
 * no browser is open at night; change one, change the other. verify-whatsapp checks the two
 * agree on every figure's wording.
 *
 * Written with createElement rather than JSX (this backend has no JSX build) and loaded with a
 * real dynamic import: @react-pdf/renderer ships only as an ES module and this is CommonJS.
 *
 * One deliberate difference: "Generated" is printed in the shop's own time zone. In a browser the
 * computer's clock is the shop's; on the server it is UTC, and 10:00 pm would read 4:30 pm.
 */
import React from 'react';

// TypeScript would compile `import()` to `require()`, which cannot load an ES module.
const loadEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
let pdfLib: Promise<any> | null = null;
const lib = () => (pdfLib ??= loadEsm('@react-pdf/renderer'));

const h = React.createElement;

const money = (v: unknown) => `Rs. ${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const num = (v: unknown) => Number(v || 0).toLocaleString('en-IN');
const signed = (v: unknown) => (Number(v) >= 0 ? '+' : '') + num(v);

function buildStyles(StyleSheet: any) {
  return StyleSheet.create({
    page: { padding: 36, fontFamily: 'Helvetica', fontSize: 9, color: '#333' },

    header: { borderBottomWidth: 1, borderBottomColor: '#ddd', paddingBottom: 12, marginBottom: 16 },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#111' },
    date: { fontSize: 11, color: '#444', marginTop: 4 },
    meta: { fontSize: 8, color: '#777', textAlign: 'right', lineHeight: 1.5 },
    running: {
      marginTop: 6, fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#8a6d1f',
      backgroundColor: '#fbf3dc', paddingVertical: 3, paddingHorizontal: 6, borderRadius: 3,
      alignSelf: 'flex-start'
    },

    balanceBox: { borderWidth: 1, borderColor: '#e2e2e2', borderRadius: 4, padding: 12, marginBottom: 14 },
    balanceRow: { flexDirection: 'row', alignItems: 'flex-end' },
    figure: { flexGrow: 1, flexBasis: 0 },
    figLabel: { fontSize: 7, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
    figUnits: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#111' },
    figValue: { fontSize: 8, color: '#666', marginTop: 2 },
    figNote: { fontSize: 7, color: '#999', marginTop: 1, fontStyle: 'italic' },
    operator: { fontSize: 13, color: '#aaa', paddingHorizontal: 6, paddingBottom: 6 },
    verdict: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#eee', fontSize: 8 },
    ok: { color: '#1a7f4b' },
    bad: { color: '#b3261e', fontFamily: 'Helvetica-Bold' },

    section: { marginBottom: 12 },
    sectionTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#111', marginBottom: 2 },
    sectionSub: { fontSize: 7.5, color: '#888', marginBottom: 6 },

    statRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
    stat: { width: '20%', marginBottom: 4 },
    statLabel: { fontSize: 7, color: '#888' },
    statValue: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#111', marginTop: 2 },

    table: { borderWidth: 1, borderColor: '#eee', borderRadius: 3 },
    tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
    trLast: { flexDirection: 'row' },
    th: {
      fontSize: 7, fontFamily: 'Helvetica-Bold', color: '#666', textTransform: 'uppercase',
      letterSpacing: 0.4, padding: 5, backgroundColor: '#fafafa'
    },
    td: { fontSize: 8, padding: 5, color: '#333' },

    empty: { fontSize: 8, color: '#999', fontStyle: 'italic', paddingVertical: 6 },
    footer: {
      position: 'absolute', bottom: 20, left: 36, right: 36, fontSize: 7, color: '#aaa',
      borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 6,
      flexDirection: 'row', justifyContent: 'space-between'
    }
  });
}

export type DayBookPdfInput = {
  day: any;
  heading: string;
  businessName: string;
  locationName?: string;
  generatedBy?: string;
  /** IANA zone the "Generated" time is printed in. */
  timeZone: string;
};

/** The Day Book as PDF bytes. */
export async function renderDayBookPdf(input: DayBookPdfInput): Promise<Buffer> {
  const { Document, Page, Text, View, StyleSheet, renderToBuffer } = await lib();
  const styles = buildStyles(StyleSheet);
  const d = input.day || {};
  const printedAt = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: input.timeZone });

  const Table = ({ head, rows, widths, align = [] }: { head: string[]; rows: string[][]; widths: string[]; align?: string[] }) => {
    if (!rows?.length) return h(Text, { style: styles.empty }, 'Nothing to show.');
    return h(View, { style: styles.table },
      h(View, { style: styles.tr },
        ...head.map((th, i) => h(Text, { key: i, style: [styles.th, { width: widths[i], textAlign: align[i] || 'left' }] }, th))),
      ...rows.map((r, ri) => h(View, { key: ri, style: ri === rows.length - 1 ? styles.trLast : styles.tr, wrap: false },
        ...r.map((c, ci) => h(Text, { key: ci, style: [styles.td, { width: widths[ci], textAlign: align[ci] || 'left' }] }, c)))));
  };

  const Figure = ({ label, units, value, note, bold }: { label: string; units: unknown; value: unknown; note?: string | null; bold?: boolean }) =>
    h(View, { style: styles.figure },
      h(Text, { style: styles.figLabel }, label),
      h(Text, { style: [styles.figUnits, bold ? { fontSize: 16 } : {}] }, num(units)),
      h(Text, { style: styles.figValue }, money(value)),
      note ? h(Text, { style: styles.figNote }, note) : null);

  const Section = ({ title, subtitle }: { title: string; subtitle?: string }, ...children: any[]) =>
    h(View, { style: styles.section, wrap: false },
      h(Text, { style: styles.sectionTitle }, title),
      subtitle ? h(Text, { style: styles.sectionSub }, subtitle) : null,
      ...children);

  const stat = (label: string, value: string, width?: string) =>
    h(View, { style: width ? [styles.stat, { width }] : styles.stat },
      h(Text, { style: styles.statLabel }, label),
      h(Text, { style: styles.statValue }, value));

  const doc = h(Document, { title: `Day Book ${d.date || ''}`, author: input.businessName || 'Inventory', subject: `End of day report for ${d.date || ''}` },
    h(Page, { size: 'A4', style: styles.page },
      h(View, { style: styles.header },
        h(View, { style: styles.headerRow },
          h(View, null,
            h(Text, { style: styles.title }, 'Day Book'),
            h(Text, { style: styles.date }, input.heading || d.date)),
          h(View, null,
            h(Text, { style: styles.meta }, input.businessName || ''),
            h(Text, { style: styles.meta }, input.locationName ? `Location: ${input.locationName}` : 'All locations'),
            h(Text, { style: styles.meta }, `Business day in ${d.timezone || 'local time'}`))),
        d.inProgress ? h(Text, { style: styles.running }, 'STILL RUNNING - this day is not finished, figures will change') : null),

      d.opening && d.closing ? h(View, { style: styles.balanceBox },
        h(View, { style: styles.balanceRow },
          Figure({ label: 'Opening stock', units: d.opening.units, value: d.opening.value, note: d.opening.source === 'derived' ? 'worked back from today' : null }),
          h(Text, { style: styles.operator }, '+'),
          Figure({ label: 'Came in', units: d.stockIn?.totalUnits, value: d.stockIn?.totalValue }),
          h(Text, { style: styles.operator }, '-'),
          Figure({ label: 'Went out', units: d.stockOut?.totalUnits, value: d.stockOut?.totalValue }),
          h(Text, { style: styles.operator }, '='),
          Figure({ label: 'Closing stock', units: d.closing.units, value: d.closing.value, bold: true })),
        h(Text, { style: [styles.verdict, d.balanced === false ? styles.bad : styles.ok] },
          d.balanced === true ? 'The books balance for this day.'
            : d.balanced === false ? 'These figures do not add up - treat them as unreliable and tell support.'
              : 'No independent record exists for this day, so the totals are shown without a balance check.')) : null,

      d.quiet ? h(Text, { style: styles.empty },
        `Nothing moved this day. No stock came in or went out${d.inProgress ? ' so far' : ''}, and nothing was dispatched.`) : null,

      d.sales?.dispatchCount > 0 ? Section({ title: 'Sales dispatched', subtitle: 'Counted when the goods actually left, not when the order was written.' },
        h(View, { style: styles.statRow },
          stat('Dispatches', num(d.sales.dispatchCount)),
          stat('Units sent', num(d.sales.unitsDispatched)),
          stat('Revenue', money(d.sales.revenue)),
          stat('What it cost you', money(d.sales.costOfGoods)),
          stat('Profit', money(d.sales.grossProfit))),
        Table({
          head: ['Dispatch', 'Order', 'Customer', 'Units', 'Value'],
          widths: ['20%', '20%', '30%', '12%', '18%'],
          align: ['left', 'left', 'left', 'right', 'right'],
          rows: (d.sales.orders || []).map((o: any) => [o.dispatchNumber, o.orderNumber, o.customer || '-', num(o.units), money(o.value)])
        })) : null,

      Section({ title: 'Stock that came in', subtitle: `${num(d.stockIn?.totalUnits)} units, ${money(d.stockIn?.totalValue)}` },
        Table({ head: ['Reason', 'Units', 'Value'], widths: ['60%', '18%', '22%'], align: ['left', 'right', 'right'],
          rows: (d.stockIn?.lines || []).map((l: any) => [l.label || l.reason, num(l.units), money(l.value)]) })),

      Section({ title: 'Stock that went out', subtitle: `${num(d.stockOut?.totalUnits)} units, ${money(d.stockOut?.totalValue)}` },
        Table({ head: ['Reason', 'Units', 'Value'], widths: ['60%', '18%', '22%'], align: ['left', 'right', 'right'],
          rows: (d.stockOut?.lines || []).map((l: any) => [l.label || l.reason, num(l.units), money(l.value)]) })),

      d.transfers?.unitsMoved > 0 ? Section({ title: 'Moved between your own locations', subtitle: 'Your total stock does not change - it just sits somewhere else.' },
        h(Text, { style: { fontSize: 9 } }, `${num(d.transfers.unitsMoved)} units moved`)) : null,

      d.byLocation?.length > 0 ? Section({ title: 'By location', subtitle: 'What changed where.' },
        Table({
          head: ['Location', 'In', 'Out', 'Net change', 'Transferred in', 'Transferred out'],
          widths: ['30%', '12%', '12%', '16%', '15%', '15%'],
          align: ['left', 'right', 'right', 'right', 'right', 'right'],
          rows: d.byLocation.map((l: any) => [
            `${l.name} (${l.code})`, `+${num(l.unitsIn)}`, `-${num(l.unitsOut)}`, signed(l.netChange),
            l.transferIn ? `+${num(l.transferIn)}` : '-', l.transferOut ? `-${num(l.transferOut)}` : '-'
          ])
        })) : null,

      d.topMovers?.length > 0 ? Section({ title: 'Busiest items' },
        Table({ head: ['Item', 'SKU', 'In', 'Out'], widths: ['48%', '26%', '13%', '13%'], align: ['left', 'left', 'right', 'right'],
          rows: d.topMovers.map((m: any) => [m.title || '-', m.sku || '-', `+${num(m.unitsIn)}`, `-${num(m.unitsOut)}`]) })) : null,

      d.adjustments?.length > 0 ? Section({ title: 'Manual corrections', subtitle: 'Changes somebody made by hand, rather than from an order or a delivery.' },
        Table({ head: ['Item', 'Change', 'Reason', 'By'], widths: ['38%', '14%', '26%', '22%'], align: ['left', 'right', 'left', 'left'],
          rows: d.adjustments.map((a: any) => [`${a.title || ''} ${a.sku || ''}`.trim() || '-', signed(a.units), a.reason, a.by || '-']) })) : null,

      d.alsoToday ? Section({ title: 'Also on this day' },
        h(View, { style: styles.statRow },
          stat('Purchase orders raised', num(d.alsoToday.purchaseOrdersRaised), '33%'),
          stat('Purchase orders received', num(d.alsoToday.purchaseOrdersReceived), '33%'),
          stat('New items added', num(d.alsoToday.newVariantsAdded), '33%'))) : null,

      h(View, { style: styles.footer, fixed: true },
        h(Text, null, `Generated ${printedAt}${input.generatedBy ? ` by ${input.generatedBy}` : ''}`),
        h(Text, { render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}` }))));

  return renderToBuffer(doc);
}
