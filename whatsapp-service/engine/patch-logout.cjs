// Makes "Unlink" really unlink (Evolution API 2.3.7, Baileys 7.0.0-rc.9).
//
// Baileys' logout() sends WhatsApp the remove-companion-device request and closes the socket in
// the same breath, without waiting for the answer. When the close wins, WhatsApp never removes
// the device: the phone still lists it as active, the engine's saved login still works, and the
// next "Link" comes back CONNECTED with no scan (seen in production, 18 Sep 2026). This waits for
// WhatsApp's answer (up to 10 s) before closing. A refusal or a timeout still logs out locally.
//
// Run at image build time. It fails the build if the code it expects is not there.
const fs = require('fs');

const FILE = '/evolution/node_modules/baileys/lib/Socket/socket.js';
let src = fs.readFileSync(FILE, 'utf8');

const from = `        if (jid) {
            await sendNode({
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    type: 'set',
                    id: generateMessageTag(),
                    xmlns: 'md'
                },
                content: [
                    {
                        tag: 'remove-companion-device',
                        attrs: {
                            jid,
                            reason: 'user_initiated'
                        }
                    }
                ]
            });
        }
        end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }));`;

const to = `        if (jid) {
            try {
                // query() resolves on WhatsApp's answer; sendNode() only on the local write.
                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'remove-companion-device',
                            attrs: {
                                jid,
                                reason: 'user_initiated'
                            }
                        }
                    ]
                }, 10000);
            }
            catch (err) {
                // WhatsApp may drop the stream as its answer; either way the local logout goes on.
                logger.warn({ reason: err?.message }, 'remove-companion-device was not confirmed before logout');
            }
        }
        end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }));`;

const at = src.indexOf(from);
if (at === -1 || src.indexOf(from, at + 1) !== -1) {
  console.error('logout patch: expected code not found exactly once');
  process.exit(1);
}
if (!/const query = async \(node, timeoutMs\) =>/.test(src)) {
  console.error('logout patch: query(node, timeoutMs) not found');
  process.exit(1);
}
fs.writeFileSync(FILE, src.replace(from, to));
console.log('logout patch applied');
