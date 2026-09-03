/**
 * Gmail -> Sheet -> review request.
 *
 * Two functions, one sheet.
 *
 *   getEmailsToSheetOnsite()  pulls the most recent threads carrying the
 *                             "Onsite" Gmail label into the "Onsite Extract"
 *                             sheet, one row per message, deduplicated by
 *                             Gmail message id.
 *   sendFeedbackEmails()      walks that sheet and sends one review request
 *                             per address that has not been written to yet,
 *                             then stamps the row so it is never written twice.
 *
 * The dedup lives in two places on purpose: column A holds the Gmail message
 * id so the same email is never imported twice, and column H holds the send
 * stamp so the same customer is never asked twice. Losing either column means
 * customers get a second email, which is the one failure mode that costs a
 * review instead of earning one.
 *
 * Sheet layout ("Onsite Extract"):
 *   A Message ID  B Date  C Sender  D Receiver  E Subject  F Body
 *   G Customer Name (filled by a sheet formula parsing column F)
 *   H Status (written by this script)
 *
 * Configure the three constants below before running.
 */

// --- configuration ---------------------------------------------------------
var SHEET_NAME    = 'Onsite Extract';
var GMAIL_LABEL   = 'Onsite';
var REVIEW_URL    = 'https://g.page/r/YOUR_GOOGLE_REVIEW_ID/review';
var SENDER_NAME   = 'Your Business Name';
var WHATSAPP      = '+39 XXX XXXXXXX';
var TIMEZONE_SHIFT_HOURS = 2;  // Gmail returns UTC; shift to local time

// ---------------------------------------------------------------------------
// 1. Import
// ---------------------------------------------------------------------------
function getEmailsToSheetOnsite() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found');

  // Only the 5 most recent threads (about 10 messages). The job runs often
  // enough that a wider window would only re-read rows already imported.
  const threads = GmailApp.search('label:' + GMAIL_LABEL, 0, 5);
  const messages = threads.flatMap(t => t.getMessages()).slice(-10);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Message ID', 'Date', 'Sender', 'Receiver', 'Subject', 'Body']);
  }

  const lastRow = sheet.getLastRow();
  const existingIds = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat()
    : [];

  messages.forEach(message => {
    const messageId = message.getId();
    if (existingIds.includes(messageId)) return;

    const date = new Date(message.getDate().getTime() + TIMEZONE_SHIFT_HOURS * 60 * 60 * 1000);
    const row = [
      messageId,
      date,
      message.getFrom(),
      message.getTo(),
      message.getSubject(),
      message.getPlainBody()
    ];

    // Reuse the first fully empty row in A:F, otherwise append.
    const data = sheet.getRange(2, 1, sheet.getLastRow() || 1, 6).getValues();
    let emptyRowIndex = data.findIndex(r => r.every(cell => cell === '')) + 2;
    if (emptyRowIndex < 2) emptyRowIndex = sheet.getLastRow() + 1;

    sheet.getRange(emptyRowIndex, 1, 1, 6).setValues([row]);
  });
}

// ---------------------------------------------------------------------------
// 2. Send
// ---------------------------------------------------------------------------
function sendFeedbackEmails() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found');

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {   // row 0 is the header
    const row = data[i];
    const emailAddress = row[3];   // D Receiver
    const customerName = row[6];   // G Customer Name
    const status       = row[7];   // H Status

    // Send only when there is an address and the row has never been stamped.
    if (!emailAddress) continue;
    if (status && status.toString().trim() !== '') continue;

    try {
      let displayName = 'there';
      if (customerName && customerName !== 'Name not found' && customerName.toString().trim() !== '') {
        displayName = customerName.toString().trim();
      }

      GmailApp.sendEmail(emailAddress, 'Hey there, how was your stay?', '', {
        htmlBody: getFeedbackHtml(displayName),
        name: SENDER_NAME
      });

      sheet.getRange(i + 1, 8).setValue('Feedback Sent: ' + new Date().toLocaleDateString());
      Utilities.sleep(200);   // stay under the Gmail rate limit

    } catch (e) {
      console.error('Failed to send to: ' + emailAddress + ' Error: ' + e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The email
// ---------------------------------------------------------------------------
function getFeedbackHtml(displayName) {
  const star =
    '<td style="padding:0 3px;font-size:34px;line-height:34px;font-family:Arial,Helvetica,sans-serif;">' +
    '<a href="' + REVIEW_URL + '" style="color:#F5B301;text-decoration:none;">&#9734;</a></td>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<title>${SENDER_NAME}</title>
<style>
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; margin:0; padding:0;
         background-color:#f9f9f9; color:#333; -webkit-font-smoothing:antialiased; }
  .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent;
               height:0; width:0; overflow:hidden; mso-hide:all; }
  .container { max-width:600px; margin:20px auto; background-color:#ffffff;
               border:1px solid #e0e0e0; border-radius:12px; overflow:hidden;
               box-shadow:0 4px 12px rgba(0,0,0,0.05); }
  .header { background:#0074B1;
            background:linear-gradient(to right,#0074B1 0%,#0088A9 50%,#00A3A0 100%);
            color:#ffffff; padding:28px 36px; }
  .header h1 { margin:0; font-size:24px; font-weight:bold; letter-spacing:0.2px; }
  .content { padding:36px; }
  .greeting { font-size:23px; font-weight:bold; margin-bottom:12px; color:#222; }
  .intro-text { font-size:16px; margin-bottom:28px; color:#444; line-height:1.6; }
  .feedback-card { background-color:#f8f9fa; border:1px solid #edf0f2; border-radius:8px;
                   padding:32px; margin-bottom:20px; text-align:center; }
  .card-label { color:#8e98a1; font-size:13px; margin-bottom:8px; font-weight:600;
                text-transform:uppercase; letter-spacing:0.5px; }
  .card-value { font-size:21px; font-weight:bold; margin-bottom:14px; color:#1a1a1a; }
  .card-text { font-size:15px; color:#555; margin:0 auto 22px auto; line-height:1.55; max-width:400px; }
  .stars-caption { font-size:13px; color:#8e98a1; margin-bottom:22px; letter-spacing:0.3px; }
  .button { display:inline-block; background-color:#0088A9; color:#ffffff !important;
            padding:15px 34px; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; }
  .ps { font-size:14px; color:#7a8691; line-height:1.55; margin:0 0 4px 0; }
  .footer { text-align:center; padding:30px 36px; font-size:13px; color:#7a8691;
            border-top:1px solid #f0f2f4; line-height:1.6; }
  @media only screen and (max-width:620px) {
    .content { padding:26px 22px; }
    .feedback-card { padding:26px 18px; }
    .greeting { font-size:21px; }
    .header { padding:24px 22px; }
    .button { display:block; padding:16px 0; }
  }
</style>
</head>
<body>
  <span class="preheader">It takes about 30 seconds and really helps a small local business.</span>
  <div class="container">
    <div class="header"><h1>${SENDER_NAME}</h1></div>
    <div class="content">
      <div class="greeting">Thanks for choosing us, ${displayName}!</div>
      <p class="intro-text">We hope everything went smoothly.</p>

      <div class="feedback-card">
        <div class="card-label">How was your experience?</div>
        <div class="card-value">Would you leave us a quick review?</div>
        <p class="card-text">You would be a huge help to a small local business, and to the next
        traveller looking for a safe place for their bags. It takes about 30 seconds.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"
               style="margin:0 auto 6px auto;">
          <tr>${star}${star}${star}${star}${star}</tr>
        </table>
        <div class="stars-caption">Tap to rate us on Google</div>
        <a href="${REVIEW_URL}" class="button"
           style="background-color:#0088A9;color:#ffffff;padding:15px 34px;text-decoration:none;
                  border-radius:6px;font-weight:bold;font-size:16px;display:inline-block;">Leave a review</a>
      </div>

      <p class="ps">P.S. If anything was less than perfect, just reply to this email and we will make it right.</p>
    </div>
    <div class="footer">
      ${SENDER_NAME} &bull; Secure, self-service luggage deposit<br>
      WhatsApp: ${WHATSAPP}
    </div>
  </div>
</body>
</html>`;
}
