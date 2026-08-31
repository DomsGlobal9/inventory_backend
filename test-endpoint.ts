import axios from 'axios';
import fs from 'fs';

async function run() {
  const creds = JSON.parse(fs.readFileSync('./test-creds.json', 'utf8'));
  const token = creds.ADMIN.token;

  try {
    const res = await axios.get('http://localhost:4006/api/v1/inventory/alerts', {
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'x-client-id': 'demo-client'
      }
    });
    console.log('Success:', res.data);
  } catch (err: any) {
    console.error('Error:', err.response?.data || err.message);
  }
}

run();
