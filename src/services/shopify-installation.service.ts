import axios from 'axios';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { normaliseShopDomain, adminApiBase } from '../utils/shopifyDomain';
import { verifyOAuthCallback, generateNonce } from '../utils/shopifyHmac';

/**
 * Installing the Shopify app, and holding the token afterwards.
 *
 * Two things in here are worth reading before changing anything.
 *
 * THE TOKEN IS ENCRYPTED, NOT HASHED. Everywhere else in the storefront code a credential is
 * hashed, because we only ever need to VERIFY what someone presents. Shopify is the opposite:
 * every Admin API call replays this token, so it must come back out. That is a different
 * security posture, deliberately, and it is why these live in their own column rather than in
 * StorefrontConnection.credentialHash.
 *
 * THE TENANT BINDING DOES NOT TRAVEL THROUGH THE BROWSER. Which ScaleEzy client a shop belongs
 * to decides whose inventory is published to that storefront, so it is held in a server-side
 * row keyed by an opaque nonce. The browser carries the nonce and nothing else.
 */

const TOKEN_PATH = '/admin/oauth/access_token';
const STATE_TTL_MS = 10 * 60 * 1000;
/** Renew this far before expiry, so a call in flight does not fail on a boundary. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export class ShopifyConfigurationError extends Error {}
export class ShopifyInstallError extends Error {}

function requireConfig() {
  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL } = env;
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_APP_URL) {
    // Deliberately explicit. The alternative is redirecting a merchant to Shopify with an empty
    // client_id, so they meet an error on Shopify's own domain with nothing to act on.
    throw new ShopifyConfigurationError(
      'Shopify is not configured on this deployment. SHOPIFY_API_KEY, SHOPIFY_API_SECRET and ' +
      'SHOPIFY_APP_URL must all be set before a store can be connected.'
    );
  }
  return { key: SHOPIFY_API_KEY, secret: SHOPIFY_API_SECRET, appUrl: SHOPIFY_APP_URL.replace(/\/$/, '') };
}

/** The redirect URL registered in the Shopify app. Compared as a STRING by Shopify, so exact. */
export function redirectUri(): string {
  return `${requireConfig().appUrl}/api/v1/shopify/callback`;
}

export class ShopifyInstallationService {
  /**
   * Step one: where to send the merchant.
   *
   * `clientId` is present when the install started inside ScaleEzy, and absent when it started
   * on Shopify's side -- in which case the installation lands unclaimed and does nothing until
   * a signed-in merchant claims it.
   */
  async beginInstall(input: { shop: string; clientId?: string; userId?: string }) {
    const { key, secret } = requireConfig();
    void secret;

    const shopDomain = normaliseShopDomain(input.shop);
    if (!shopDomain) {
      throw new ShopifyInstallError(
        'That does not look like a Shopify store address. It should end in .myshopify.com'
      );
    }

    // One shop cannot serve two tenants: two inventories would fight over one storefront, each
    // overwriting the other's stock levels forever. Caught here rather than at the callback, so
    // the merchant is told before they approve anything on Shopify.
    const existing = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain },
      select: { clientId: true, uninstalledAt: true }
    });
    if (existing && !existing.uninstalledAt && existing.clientId && input.clientId
        && existing.clientId !== input.clientId) {
      throw new ShopifyInstallError(
        `${shopDomain} is already connected to a different ScaleEzy workspace. Disconnect it there first.`
      );
    }

    const nonce = generateNonce();
    await prisma.shopifyOAuthState.create({
      data: {
        nonce,
        shopDomain,
        clientId: input.clientId ?? null,
        startedByUser: input.userId ?? null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS)
      }
    });

    const params = new URLSearchParams({
      client_id: key,
      scope: env.SHOPIFY_SCOPES,
      redirect_uri: redirectUri(),
      state: nonce
    });

    return { shopDomain, authorizeUrl: `https://${shopDomain}/admin/oauth/authorize?${params}` };
  }

  /**
   * Step two: the merchant is back from Shopify.
   *
   * Four checks, and all four are load bearing:
   *
   *   1. the shop is a real .myshopify.com host       -- or we post our client_secret elsewhere
   *   2. the query signature verifies                 -- proves Shopify sent it, unaltered
   *   3. the nonce matches an unconsumed row          -- proves WE started this install
   *   4. the row's shop matches the callback's shop   -- proves the binding was not redirected
   *
   * Check 2 alone is not enough: it says the message came from Shopify, not that it belongs to
   * a flow we began. Check 3 alone is not enough either. Both, or neither.
   */
  async completeInstall(query: Record<string, unknown>) {
    const { key, secret } = requireConfig();

    const shopDomain = normaliseShopDomain(query.shop);
    if (!shopDomain) throw new ShopifyInstallError('Invalid shop parameter.');

    if (!verifyOAuthCallback(query, secret)) {
      throw new ShopifyInstallError('This link did not come from Shopify, or has been altered.');
    }

    const nonce = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (!nonce || !code) throw new ShopifyInstallError('Incomplete callback from Shopify.');

    // Consumed atomically. Two callbacks racing with the same nonce -- a double-clicked link,
    // or a replay -- must not both proceed to create an installation.
    const claimed = await prisma.shopifyOAuthState.updateMany({
      where: { nonce, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() }
    });
    if (claimed.count !== 1) {
      throw new ShopifyInstallError(
        'This installation link has expired or was already used. Start the connection again.'
      );
    }

    const state = await prisma.shopifyOAuthState.findUnique({ where: { nonce } });
    if (!state || state.shopDomain !== shopDomain) {
      throw new ShopifyInstallError('This installation link does not match the store it was issued for.');
    }

    // `expiring=1` asks for a short-lived access token plus a refresh token. Public apps must
    // use expiring offline tokens for GraphQL Admin requests, so this is the shape to build
    // around rather than a permanent token that would later have to be migrated.
    const response = await axios.post(
      `https://${shopDomain}${TOKEN_PATH}`,
      { client_id: key, client_secret: secret, code, expiring: 1 },
      { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true }
    );

    if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
      throw new ShopifyInstallError(
        `Shopify refused the installation (HTTP ${response.status}). The authorisation code may have already been used.`
      );
    }

    const granted: string = response.data.scope ?? '';
    const expiresIn: number | undefined = response.data.expires_in;
    const refreshExpiresIn: number | undefined = response.data.refresh_token_expires_in;

    // Shopify's own numeric id for the shop, which never changes.
    //
    // A merchant CAN change their .myshopify.com domain -- once, but once is enough. Keyed on
    // the domain alone, a renamed store comes back as a stranger: a second installation, an
    // empty id map, and a catalogue duplicated into their live storefront. The id is read here
    // so a rename is recognised as the same shop and only the domain moves.
    const shopId = await this.fetchShopId(shopDomain, response.data.access_token);

    if (shopId) {
      const previous = await prisma.shopifyInstallation.findFirst({
        where: { shopifyShopId: shopId, shopDomain: { not: shopDomain } },
        select: { id: true, shopDomain: true }
      });
      if (previous) {
        console.warn(
          `[Shopify] ${previous.shopDomain} now answers as ${shopDomain} (same shop id ${shopId}). ` +
          `Moving the existing installation rather than creating a second one.`
        );
        await prisma.shopifyInstallation.update({
          where: { id: previous.id }, data: { shopDomain }
        });
      }
    }

    // A merchant can approve fewer scopes than were asked for. Recorded rather than assumed, so
    // an operation that needs one can say which is missing instead of failing as "403 from
    // Shopify", which reads like our bug.
    const installation = await prisma.shopifyInstallation.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        shopifyShopId: shopId,
        clientId: state.clientId,
        source: state.clientId ? 'SCALEEZY' : 'SHOPIFY',
        accessTokenEncrypted: encryptCredential(response.data.access_token),
        refreshTokenEncrypted: response.data.refresh_token
          ? encryptCredential(response.data.refresh_token) : null,
        accessTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        refreshTokenExpiresAt: refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null,
        scopes: granted,
        claimedAt: state.clientId ? new Date() : null,
        claimedByUser: state.startedByUser
      },
      update: {
        // A reinstall after an uninstall reuses the row and clears the tombstone, so the id
        // maps built last time survive -- otherwise every reinstall duplicates the catalogue.
        uninstalledAt: null,
        shopifyShopId: shopId ?? undefined,
        clientId: state.clientId ?? undefined,
        accessTokenEncrypted: encryptCredential(response.data.access_token),
        refreshTokenEncrypted: response.data.refresh_token
          ? encryptCredential(response.data.refresh_token) : null,
        accessTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        refreshTokenExpiresAt: refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null,
        scopes: granted,
        claimedAt: state.clientId ? new Date() : undefined,
        claimedByUser: state.startedByUser ?? undefined
      },
      select: { id: true, shopDomain: true, clientId: true, scopes: true, source: true }
    });

    return { installation, grantedScopes: granted, requestedScopes: env.SHOPIFY_SCOPES };
  }

  /**
   * Reads the shop's permanent numeric id, immediately after the token is issued.
   *
   * Deliberately best-effort. If Shopify is briefly unavailable the install still succeeds --
   * we hold a working token, and refusing the whole installation over a missing identifier
   * would be a worse outcome than filling it in on the next install or sync. Null is recorded,
   * not an error thrown.
   */
  private async fetchShopId(shopDomain: string, accessToken: string): Promise<string | null> {
    try {
      const response = await axios.post(
        `${adminApiBase(shopDomain, env.SHOPIFY_API_VERSION)}/graphql.json`,
        { query: '{ shop { id name } }' },
        {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
          validateStatus: () => true
        }
      );
      const id = response.data?.data?.shop?.id;
      return typeof id === 'string' && id ? id : null;
    } catch (error) {
      console.error(`[Shopify] could not read the shop id for ${shopDomain}; the install continues`, error);
      return null;
    }
  }

  /**
   * The access token for a shop, renewed if it is about to expire.
   *
   * Every Admin API call goes through here rather than reading the column directly, so there is
   * exactly one place that knows about expiry -- and no caller can accidentally use a token
   * that expired thirty seconds ago.
   */
  async accessTokenFor(installationId: string): Promise<string> {
    const installation = await prisma.shopifyInstallation.findUnique({
      where: { id: installationId },
      select: {
        id: true, shopDomain: true, uninstalledAt: true,
        accessTokenEncrypted: true, refreshTokenEncrypted: true, accessTokenExpiresAt: true
      }
    });
    if (!installation) throw new ShopifyInstallError('Unknown Shopify installation.');
    if (installation.uninstalledAt) {
      throw new ShopifyInstallError(`The app has been uninstalled from ${installation.shopDomain}.`);
    }

    const expiring = installation.accessTokenExpiresAt
      && installation.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS < Date.now();

    if (expiring && installation.refreshTokenEncrypted) {
      return this.refresh(installation.id, installation.shopDomain, installation.refreshTokenEncrypted);
    }

    return decryptCredential(installation.accessTokenEncrypted);
  }

  /**
   * Renews an expiring token.
   *
   * The refresh token ROTATES: the response carries a new one, and the old is spent. Storing
   * both from the same response, in one write, is what stops a crash between the two leaving an
   * installation that can neither call nor refresh -- which would need a manual reinstall.
   */
  private async refresh(id: string, shopDomain: string, refreshTokenEncrypted: string): Promise<string> {
    const { key, secret } = requireConfig();
    const refreshToken = decryptCredential(refreshTokenEncrypted);

    const response = await axios.post(
      `https://${shopDomain}${TOKEN_PATH}`,
      {
        client_id: key,
        client_secret: secret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      },
      { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true }
    );

    if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
      throw new ShopifyInstallError(
        `Could not renew access to ${shopDomain} (HTTP ${response.status}). The merchant may need to reconnect.`
      );
    }

    const expiresIn: number | undefined = response.data.expires_in;
    const refreshExpiresIn: number | undefined = response.data.refresh_token_expires_in;

    await prisma.shopifyInstallation.update({
      where: { id },
      data: {
        accessTokenEncrypted: encryptCredential(response.data.access_token),
        refreshTokenEncrypted: response.data.refresh_token
          ? encryptCredential(response.data.refresh_token) : refreshTokenEncrypted,
        accessTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        refreshTokenExpiresAt: refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : undefined
      }
    });

    return response.data.access_token;
  }

  /**
   * Claims an installation that arrived from Shopify's side with no tenant attached.
   *
   * The shop domain is shown to the merchant before this is called, so a shop can never be
   * claimed blind -- claiming binds someone else's catalogue to your storefront if it is wrong.
   */
  async claim(shopDomain: string, clientId: string, userId?: string) {
    const shop = normaliseShopDomain(shopDomain);
    if (!shop) throw new ShopifyInstallError('Invalid shop domain.');

    const installation = await prisma.shopifyInstallation.findUnique({ where: { shopDomain: shop } });
    if (!installation) throw new ShopifyInstallError('That store has not installed the app.');
    if (installation.uninstalledAt) throw new ShopifyInstallError('That store has uninstalled the app.');
    if (installation.clientId && installation.clientId !== clientId) {
      throw new ShopifyInstallError('That store is already connected to a different workspace.');
    }

    return prisma.shopifyInstallation.update({
      where: { id: installation.id },
      data: { clientId, claimedAt: new Date(), claimedByUser: userId ?? null },
      select: { id: true, shopDomain: true, clientId: true }
    });
  }

  /**
   * The app was removed from the store.
   *
   * The token is dead the moment Shopify says this, so it is cleared rather than kept -- there
   * is nothing it can be used for, and a dead secret on disk is a liability with no upside. The
   * id maps are deliberately KEPT: a merchant who reinstalls next week should find their
   * catalogue still matched rather than duplicated.
   */
  async markUninstalled(shopDomain: string) {
    const shop = normaliseShopDomain(shopDomain);
    if (!shop) return null;

    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain: shop }, select: { id: true, clientId: true }
    });
    if (!installation) return null;

    await prisma.shopifyInstallation.update({
      where: { id: installation.id },
      data: {
        uninstalledAt: new Date(),
        accessTokenEncrypted: encryptCredential(''),
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null
      }
    });

    return installation;
  }

  /** Removes expired, unconsumed OAuth attempts. Housekeeping, safe to run at any time. */
  async pruneExpiredStates() {
    const { count } = await prisma.shopifyOAuthState.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    });
    return count;
  }

  /**
   * Which of the scopes we asked for the merchant did not grant.
   *
   * `write_x` implies `read_x`, and Shopify COLLAPSES the pair when it records what was
   * granted: ask for `read_products,write_products` and it reports back `write_products`
   * alone. Comparing the two lists literally therefore reports `read_products` as declined
   * when it was granted -- and the merchant is told to reconnect and approve a permission
   * they already approved, which they cannot fix because there is nothing wrong.
   */
  missingScopes(granted: string): string[] {
    const have = new Set(granted.split(',').map(s => s.trim()).filter(Boolean));
    // A granted write implies the matching read, so expand before comparing.
    for (const scope of [...have]) {
      if (scope.startsWith('write_')) have.add(scope.replace(/^write_/, 'read_'));
    }
    return env.SHOPIFY_SCOPES.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(scope => !have.has(scope));
  }
}

export const shopifyInstallationService = new ShopifyInstallationService();
