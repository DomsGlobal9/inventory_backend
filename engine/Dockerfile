# The WhatsApp engine ScaleEzy runs: Evolution API 2.3.7 with the QR-linking fix applied.
# Remove the patch once an Evolution release ships a Baileys that handles companion_reg_refresh.
# Pinned by digest: the tag alone could be re-pushed, and the patch must see exactly this code.
FROM evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339

COPY patch-pairing.cjs /tmp/patch-pairing.cjs
RUN node /tmp/patch-pairing.cjs && rm /tmp/patch-pairing.cjs
