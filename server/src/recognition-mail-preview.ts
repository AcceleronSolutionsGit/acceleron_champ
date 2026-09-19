/**
 * Render the recognition mail to a file so it can be eyeballed in a browser
 * (and pasted into Outlook to check the Word renderer) without a database, a
 * mail server or a real recognition.
 *
 *   npm run mail:preview -w server
 *   npm run mail:preview -w server -- ./out.html
 *
 * The sample uses the same shape the live path produces: a full HRMS name, a
 * behaviour row with its colour, a reason typed by a person on WhatsApp.
 */
import fs from 'fs'
import path from 'path'
import {
  RecognitionMailInput,
  recognitionSubject,
  renderRecognitionHtml,
  renderRecognitionText,
} from './modules/mail/recognitionMail'

const sample: RecognitionMailInput = {
  recognitionId: 4127,
  recipientName: 'Priya Nair',
  giverName: 'Rahul Verma',
  giverFunction: 'Engineering',
  giverSite: 'Pune',
  managerName: 'Sabarnik Lahiri',
  behaviourName: 'CUSTOMER CENTRICITY',
  behaviourDescription: 'Your outcomes. Our responsibility.',
  behaviourColour: '#e58f00',
  reason:
    'Stayed back on Friday to rebuild the despatch report after the customer flagged the wrong line totals, and had the corrected file with them before their Monday review.',
  createdAt: new Date().toISOString(),
  consoleUrl: 'https://acceleron-champ-server.vercel.app/feed',
}

const out = path.resolve(process.argv[2] ?? 'recognition-mail-preview.html')
fs.writeFileSync(out, renderRecognitionHtml(sample), 'utf8')

console.log(`Subject: ${recognitionSubject(sample)}`)
console.log('\n--- text/plain ---\n')
console.log(renderRecognitionText(sample))
console.log(`\n--- text/html ---\nwritten to ${out}`)
