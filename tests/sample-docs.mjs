// Realistic sample PDFs for end-to-end tests and screenshots.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

function wrap(text, font, size, width) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function tenancyAgreement({ revised = false } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle('Assured Shorthold Tenancy Agreement');
  doc.setAuthor('Landon & Co. Lettings');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sections = [
    ['1. Parties', `This agreement is made between Harbour Properties Ltd (the Landlord) and Jordan Ellis (the Tenant), email jordan.ellis@example.com, telephone 020 7946 0958. The Tenant's National Insurance number is AB 12 34 56 C.`],
    ['2. The Property', 'The Landlord lets the Tenant the residential property at Flat 4, 18 Wharf Road, London N1 7GR, together with the fixtures, fittings and furniture listed in the inventory.'],
    ['3. Term', `The tenancy starts on 1 December 2026 and continues for a fixed term of ${revised ? 'eighteen' : 'twelve'} months. After the fixed term ends the tenancy will continue as a periodic tenancy from month to month.`],
    ['4. Rent', `The rent is ${revised ? '£1,950' : '£1,850'} per calendar month, payable in advance on the first day of each month by standing order. Rent may be reviewed once a year with at least one month's written notice.`],
    ['5. Deposit', 'The Tenant shall pay a deposit of £2,134.61 which the Landlord will protect in a government-approved tenancy deposit scheme within 30 days of receipt.'],
    ['6. Tenant obligations', 'The Tenant agrees to keep the interior of the property clean and in good condition, not to sublet without written consent, and to allow access for repairs on 24 hours notice except in an emergency.'],
    ['7. Landlord obligations', 'The Landlord agrees to keep in repair the structure and exterior of the property and the installations for the supply of water, gas, electricity, sanitation and heating, as required by section 11 of the Landlord and Tenant Act 1985.'],
    ['8. Ending the tenancy', `The Tenant may end the tenancy after the fixed term by giving at least one month's written notice. The Landlord must give notice in accordance with the Housing Act 1988.${revised ? ' A break clause allows either party to end the tenancy after six months on two months notice.' : ''}`],
    ['9. Signatures', 'Signed by the Landlord and the Tenant on the date shown below.'],
  ];
  let page;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: rgb(0.11, 0.12, 0.2) });
    page.drawText('LANDON & CO. LETTINGS', { x: 56, y: 822, size: 9, font: bold, color: rgb(1, 1, 1) });
    y = 770;
  };
  newPage();
  page.drawText('Assured Shorthold Tenancy Agreement', { x: 56, y, size: 22, font: bold, color: rgb(0.08, 0.08, 0.12) });
  y -= 26;
  page.drawText('Housing Act 1988, section 19A', { x: 56, y, size: 11, font, color: rgb(0.4, 0.4, 0.5) });
  y -= 36;
  for (const [title, body] of sections) {
    const lines = wrap(body, font, 11, 483);
    if (y - 24 - lines.length * 16 < 80) newPage();
    page.drawText(title, { x: 56, y, size: 13, font: bold, color: rgb(0.25, 0.2, 0.6) });
    y -= 20;
    for (const l of lines) {
      page.drawText(l, { x: 56, y, size: 11, font, color: rgb(0.12, 0.12, 0.16) });
      y -= 16;
    }
    y -= 14;
  }
  page.drawLine({ start: { x: 56, y: y - 30 }, end: { x: 260, y: y - 30 }, thickness: 0.8, color: rgb(0.5, 0.5, 0.6) });
  page.drawText('Tenant signature', { x: 56, y: y - 44, size: 9, font, color: rgb(0.4, 0.4, 0.5) });
  const form = doc.getForm();
  const date = form.createTextField('Date signed');
  date.addToPage(page, { x: 320, y: y - 36, width: 160, height: 22 });
  // Schedules on their own pages.
  const schedules = [
    ['Schedule 1: Inventory', ['Living room: two-seat sofa, oak coffee table, floor lamp, curtains.', 'Kitchen: fridge-freezer, washing machine, four-ring hob and oven, microwave.', 'Bedroom: double bed with mattress, wardrobe, chest of drawers, blackout blinds.', `Bathroom: mirrored cabinet, shower screen${revised ? ', heated towel rail' : ''}.`]],
    ['Schedule 2: House rules', ['No smoking anywhere in the property.', 'Pets only with the Landlord\'s written consent.', 'Bins to be put out on Tuesday evenings.', 'Report any leaks or damp to the managing agent within 48 hours.']],
  ];
  for (const [title, items] of schedules) {
    newPage();
    page.drawText(title, { x: 56, y, size: 18, font: bold, color: rgb(0.08, 0.08, 0.12) });
    y -= 34;
    for (const item of items) {
      for (const [k, l] of wrap(item, font, 11, 470).entries()) {
        page.drawText(`${k === 0 ? '•' : ' '}  ${l}`, { x: 56, y, size: 11, font, color: rgb(0.12, 0.12, 0.16) });
        y -= 16;
      }
      y -= 6;
    }
  }
  return doc.save();
}
