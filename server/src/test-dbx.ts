import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function testDarwinbox() {
  const baseUrl = process.env.DARWINBOX_BASE_URL || 'https://onegainwellonehr.darwinbox.in';
  const basicAuthUser = process.env.DARWINBOX_BASIC_AUTH_USER || 'PwC_1234';
  const basicAuthPass = process.env.DARWINBOX_BASIC_AUTH_PASS || 'PwC_1234';
  const apiKey = process.env.DARWINBOX_API_KEY;
  const reportId = process.env.DARWINBOX_REPORT_ID;

  const encoded = Buffer.from(`${basicAuthUser}:${basicAuthPass}`).toString('base64');
  const headers = {
    Authorization: `Basic ${encoded}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${baseUrl}/reportsbuilderapi/reportdatav2`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      api_key: apiKey,
      report_id: reportId,
      get_latest_report: '0',
    }),
  });

  const json: any = await res.json();
  console.log('summary (0):', JSON.stringify(json.response?.summary, null, 2));
  console.log('count (0):', json.response?.data?.length);
  if (json.response?.data?.length > 0) {
    const compCodes = json.response.data.map((x: any) => ({
      name: x['Full Name'],
      comp: x['Group Company Code'],
      workArea: x['Work Area Code'],
      sap: x['Sap_sbu']
    }));
    console.log('Sample rows:', compCodes.slice(0, 5));
  }
}

testDarwinbox().catch(console.error);
