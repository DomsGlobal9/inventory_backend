// Restores QR linking in Evolution API 2.3.7 (Baileys 7.0.0-rc.9).
//
// Since late July 2026 WhatsApp sends a `companion_reg_refresh` notification during QR
// linking and expects the companion to retire its advertising secret and show a QR built on
// a new one. Baileys only acks it, keeps showing a QR with the retired secret, and the phone
// says "Couldn't link device". This ports the upstream fix (Baileys#2765, carried by
// evolution-api PR #2727 for rc14) to rc.9: read the secret at render time, remember the ref
// on screen, and on the notification rotate the secret and redraw that same ref.
//
// Run at image build time. It fails the build if the code it expects is not there, so a
// changed base image can never ship silently unpatched.
const fs = require('fs');

const FILE = '/evolution/node_modules/baileys/lib/Socket/socket.js';
let src = fs.readFileSync(FILE, 'utf8');

const swaps = [
  [
    `    // QR gen\n    ws.on('CB:iq,type:set,pair-device', async (stanza) => {`,
    `    // Redraws the QR on screen with the current secret; set while a QR flow is live.\n    let refreshPairingQR;\n    // QR gen\n    ws.on('CB:iq,type:set,pair-device', async (stanza) => {`
  ],
  [
    `        const advB64 = creds.advSecretKey;\n        let qrMs = qrTimeout || 60000; // time to let a QR live`,
    `        let currentRef;\n        // The secret is read per render: a companion_reg_refresh rotates it mid-flow.\n        const renderQR = (ref) => ev.emit('connection.update', { qr: [ref, noiseKeyB64, identityKeyB64, creds.advSecretKey].join(',') });\n        refreshPairingQR = () => { if (currentRef !== undefined) renderQR(currentRef); };\n        let qrMs = qrTimeout || 60000; // time to let a QR live`
  ],
  [
    `            const ref = refNode.content.toString('utf-8');\n            const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');\n            ev.emit('connection.update', { qr });`,
    `            const ref = refNode.content.toString('utf-8');\n            currentRef = ref;\n            renderQR(ref);`
  ],
  [
    `    // device paired for the first time\n    // if device pairs successfully, the server asks to restart the connection\n    ws.on('CB:iq,,pair-success', async (stanza) => {`,
    `    // The server retiring an unlinked companion's secret. Rotate it and redraw the same ref:
    // that ref has not expired, and spending a new one would drain the server's allotment.
    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
        if (!['companion_reg_refresh', 'pair-device-rotate-qr'].some(tag => getBinaryNodeChild(node, tag))) {
            logger.warn({ id: node.attrs.id }, 'companion_reg_refresh without an expected child; ignoring');
            return;
        }
        // A linked session's secret is what the link is verified against: never re-mint it.
        if (creds.me) {
            return;
        }
        creds.advSecretKey = randomBytes(32).toString('base64');
        ev.emit('creds.update', { advSecretKey: creds.advSecretKey });
        logger.info({ id: node.attrs.id }, 'rotated the pairing secret on companion_reg_refresh; redrawing the QR');
        refreshPairingQR?.();
    });
    // device paired for the first time
    // if device pairs successfully, the server asks to restart the connection
    ws.on('CB:iq,,pair-success', async (stanza) => {`
  ]
];

for (const [from, to] of swaps) {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + 1) !== -1) {
    console.error('pairing patch: expected code not found exactly once:\n' + from.split('\n')[0]);
    process.exit(1);
  }
  src = src.replace(from, to);
}
if (!/import \{ randomBytes \} from 'crypto';/.test(src)) {
  console.error('pairing patch: randomBytes import missing');
  process.exit(1);
}
fs.writeFileSync(FILE, src);
console.log('pairing patch applied');
