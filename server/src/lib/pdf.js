import PDFDocument from 'pdfkit';

/**
 * Generate a landscape report with a branded header, KPI strip and table.
 * Returns a Buffer so routes can either stream or buffer it.
 */
export function buildReportPdf({
  title,
  subtitle = '',
  institution = 'TransitSync',
  meta = [],
  columns = [],
  rows = [],
  summary = null,
  footerNote = '',
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const ink = '#0F172A';
    const muted = '#64748B';
    const accent = '#2563EB';

    // ---- header band -------------------------------------------------------
    doc.rect(0, 0, doc.page.width, 76).fill('#0B0F17');
    doc.fillColor('#F8FAFC').fontSize(19).font('Helvetica-Bold').text(institution, 36, 22);
    doc.fontSize(11).font('Helvetica').fillColor('#94A3B8').text(title, 36, 47);
    doc.fontSize(8).font('Helvetica').fillColor('#94A3B8').text(
      `Generated ${new Date().toLocaleString('en-GB')}`,
      36,
      36,
      { width: pageWidth, align: 'right' },
    );
    doc.fillColor(ink);

    let cursorY = 96;

    if (subtitle) {
      doc.fontSize(9).font('Helvetica').fillColor(muted).text(subtitle, 36, cursorY, { width: pageWidth });
      cursorY += 16;
    }

    // ---- KPI strip ---------------------------------------------------------
    if (summary?.length) {
      const boxWidth = (pageWidth - 12 * (summary.length - 1)) / summary.length;
      summary.forEach((item, index) => {
        const x = 36 + index * (boxWidth + 12);
        doc.roundedRect(x, cursorY, boxWidth, 46, 6).fill('#F1F5F9');
        doc.fillColor(muted).fontSize(7).font('Helvetica').text(String(item.label).toUpperCase(), x + 10, cursorY + 9, { width: boxWidth - 20 });
        doc.fillColor(ink).fontSize(15).font('Helvetica-Bold').text(String(item.value), x + 10, cursorY + 22, { width: boxWidth - 20 });
      });
      cursorY += 62;
    }

    if (meta?.length) {
      doc.fontSize(8).fillColor(muted).font('Helvetica');
      doc.text(meta.map((item) => `${item.label}: ${item.value}`).join('     •     '), 36, cursorY, { width: pageWidth });
      cursorY += 20;
    }

    // ---- table -------------------------------------------------------------
    if (columns.length) {
      const widths = columns.map((column) => (column.width ?? 1) / columns.reduce((sum, c) => sum + (c.width ?? 1), 0) * pageWidth);

      const drawHead = () => {
        doc.rect(36, cursorY - 10, pageWidth, 20).fill('#E2E8F0');
        doc.fillColor(ink).fontSize(8).font('Helvetica-Bold');
        let x = 36;
        columns.forEach((column, index) => {
          doc.text(String(column.label), x + 6, cursorY - 4, { width: widths[index] - 12, ellipsis: true });
          x += widths[index];
        });
        cursorY += 14;
      };
      drawHead();

      doc.font('Helvetica').fontSize(8);
      rows.forEach((row, rowIndex) => {
        if (cursorY > doc.page.height - doc.page.margins.bottom - 24) {
          doc.addPage();
          cursorY = 60;
          drawHead();
          doc.font('Helvetica').fontSize(8);
        }
        if (rowIndex % 2 === 1) doc.rect(36, cursorY - 4, pageWidth, 16).fill('#F8FAFC');

        let x = 36;
        columns.forEach((column, index) => {
          const raw = column.format ? column.format(row[column.key], row) : row[column.key];
          const value = column.tone ? column.tone(raw, row) : String(raw ?? '');
          doc.fillColor(column.tone ? column.tone(raw, row) : ink).text(value, x + 6, cursorY, {
            width: widths[index] - 12,
            ellipsis: true,
            lineBreak: false,
          });
          x += widths[index];
        });
        cursorY += 16;
      });
      cursorY += 8;
    }

    if (!rows.length) {
      doc.fillColor(muted).fontSize(10).font('Helvetica-Oblique').text('No records matched the selected filters.', 36, cursorY);
    }

    // ---- footer on every page ---------------------------------------------
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.fontSize(7).fillColor(muted).font('Helvetica');
      doc.text(
        footerNote || 'Confidential — TransitSync operations report.',
        36,
        doc.page.height - 30,
        { width: pageWidth - 90, lineBreak: false },
      );
      doc.text(`Page ${index + 1} of ${range.count}`, doc.page.width - 126, doc.page.height - 30, {
        width: 90,
        align: 'right',
        lineBreak: false,
      });
    }

    doc.end();
  });
}

/** Colour-code outcome cells so the PDF reads at a glance. */
export const OUTCOME_TONES = {
  VALID: '#15803D',
  INVALID: '#B91C1C',
  EXPIRED: '#B45309',
  UNREGISTERED_BUS: '#C2410C',
  UNREGISTERED_CARD: '#7F1D1D',
};

export default { buildReportPdf, OUTCOME_TONES };
