import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { inventoryValueFor, inventoryValueByClient, valuationCaveatFor } from '../lib/inventoryValuation';
import { forgetClientIdentities } from '../lib/identityCache';
import { AuthService } from './auth.service';
import { seedRolesForClient } from './rbac-seed.service';
import { seedCatalogDefaultsForClient } from './catalog-seed.service';
import { supportTicketService } from './support-ticket.service';
import { buildUnifiedAuditFeed } from './audit-feed.service';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { mailService } from './mail.service';
import { supabase } from '../lib/supabase';

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe -- same scheme as team.service.ts
}

export class PlatformAdminService {
  // There is no local `Client` registry (see SUPER_ADMIN_PLAN.md) -- every clientId this
  // console can ever show is derived from the `User` table, so a client with zero users
  // is invisible here. That's a known, documented limitation, not a bug.
  // Aggregated across ALL tenants in a fixed number of queries.
  //
  // This used to be `Promise.all(clientIds.map(id => this.getClientSummary(id)))`, and
  // getClientSummary itself fires 7 queries in its own Promise.all -- so the console's
  // front page issued 7 x (tenant count) queries simultaneously. At 16 tenants that is 112
  // concurrent queries against a Prisma pool of ~17 over a pgbouncer pooler: measured at
  // 6.8s for a single load, and 4 of 6 concurrent loads failing outright with pool-timeout
  // 500s. It degraded linearly with every client onboarded -- i.e. it got worse precisely
  // as the product succeeded. Now it is 6 grouped queries regardless of tenant count.
  async listClients() {
    const [tenants, userStats, productCounts, activeProductCounts, alertCounts, valueSums, superAdmins] =
      await Promise.all([
        prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } }),
        prisma.user.groupBy({
          by: ['clientId'],
          _count: { _all: true },
          _max: { lastLoginAt: true, lastActiveAt: true }
        }),
        prisma.product.groupBy({
          by: ['clientId'],
          where: { status: { notIn: ['TRASHED'] as any } },
          _count: { _all: true }
        }),
        prisma.product.groupBy({
          by: ['clientId'],
          where: { status: 'ACTIVE' as any },
          _count: { _all: true }
        }),
        prisma.inventoryAlert.groupBy({
          by: ['clientId'],
          where: { isResolved: false },
          _count: { _all: true }
        }),
        // Valued the same way the merchant's own dashboard values it. Summing the stored
        // inventory_value column here was the cause of the console and the dashboard showing
        // different money for the same shop -- see inventoryValuation.ts. Still one query.
        inventoryValueByClient(),
        // Earliest SUPER_ADMIN per client -- ordered ascending so the first row seen for a
        // clientId is the one getClientSummary would have picked.
        prisma.user.findMany({
          where: { roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
          select: { clientId: true, name: true, email: true },
          orderBy: { createdAt: 'asc' }
        })
      ]);

    const byClient = <T extends { clientId: string }>(rows: T[]) =>
      new Map(rows.map(r => [r.clientId, r]));

    const users = byClient(userStats);
    const products = byClient(productCounts);
    const activeProducts = byClient(activeProductCounts);
    const alerts = byClient(alertCounts);
    const values = valueSums; // already a Map<clientId, number>

    const admins = new Map<string, { name: string | null; email: string | null }>();
    for (const a of superAdmins) if (!admins.has(a.clientId)) admins.set(a.clientId, a);

    return tenants.map(({ clientId }) => {
      const productCount = products.get(clientId)?._count._all ?? 0;
      const activeProductCount = activeProducts.get(clientId)?._count._all ?? 0;
      const admin = admins.get(clientId);

      return {
        clientId,
        userCount: users.get(clientId)?._count._all ?? 0,
        lastLoginAt: users.get(clientId)?._max.lastLoginAt ?? null,
        lastActiveAt: users.get(clientId)?._max.lastActiveAt ?? null,
        productCount,
        activeProductCount,
        activeAlertCount: alerts.get(clientId)?._count._all ?? 0,
        inventoryValue: values.get(clientId) ?? 0,
        // Same heuristic as getClientSummary -- kept identical so the list and the
        // single-client overview can never disagree about a client's status.
        onboardingStatus:
          productCount === 0 ? 'NOT_STARTED' : activeProductCount === 0 ? 'IN_PROGRESS' : 'ACTIVE',
        adminName: admin?.name || null,
        adminEmail: admin?.email || null
      };
    });
  }

  async getClientSummary(clientId: string) {
    const [userCount, activeUserCount, activityAgg, productCount, activeProductCount, alertCount, inventoryValue, valuationCaveat, adminUser] = await Promise.all([
      prisma.user.count({ where: { clientId } }),
      // Suspension is not a stored flag -- it is "every account is deactivated". Counting the
      // active ones is what lets the console show a suspended client as suspended rather than
      // as one that merely happens to have nobody signed in.
      prisma.user.count({ where: { clientId, status: 'ACTIVE' } }),
      prisma.user.aggregate({ where: { clientId }, _max: { lastLoginAt: true, lastActiveAt: true } }),
      prisma.product.count({ where: { clientId, status: { notIn: ['TRASHED'] } } }),
      prisma.product.count({ where: { clientId, status: 'ACTIVE' } }),
      prisma.inventoryAlert.count({ where: { clientId, isResolved: false } }),
      // The merchant's own dashboard figure, not a second opinion on it.
      inventoryValueFor(clientId),
      // And how much of it rests on a selling price rather than a cost. The merchant's
      // dashboard has always disclosed this; the console showed the same inflated number in
      // silence, which is worse here -- a merchant knows they never entered costs, while
      // Scaleezy is looking at forty shops and cannot tell which figures are real.
      valuationCaveatFor(clientId),
      prisma.user.findFirst({
        where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
        select: { name: true, email: true },
        orderBy: { createdAt: 'asc' }
      })
    ]);

    // Onboarding is a heuristic, not a stored concept -- there's no onboarding-flow
    // model anywhere in this schema. "Has ever created a product" is the simplest
    // honest signal available locally.
    const onboardingStatus = productCount === 0 ? 'NOT_STARTED' : activeProductCount === 0 ? 'IN_PROGRESS' : 'ACTIVE';

    return {
      clientId,
      userCount,
      activeUserCount,
      lastLoginAt: activityAgg._max.lastLoginAt,
      // What actually happened most recently in this client's inventory, not just when
      // someone last typed a password -- backed by lastActiveAt (bumped on every
      // authenticated business request, see activity-tracker.middleware.ts).
      lastActiveAt: activityAgg._max.lastActiveAt,
      productCount,
      activeProductCount,
      activeAlertCount: alertCount,
      inventoryValue,
      valuationCaveat,
      onboardingStatus,
      adminName: adminUser?.name || null,
      adminEmail: adminUser?.email || null
    };
  }

  async listAllUsers() {
    return prisma.user.findMany({
      select: {
        id: true,
        clientId: true,
        name: true,
        email: true,
        status: true,
        lastLoginAt: true,
        lastActiveAt: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } }
      },
      // Postgres sorts NULL as the largest value by default, so a plain `desc` here puts
      // every user who has never been active ahead of everyone with real recent activity --
      // the opposite of "most recently active first". `nulls: 'last'` fixes that.
      orderBy: { lastActiveAt: { sort: 'desc', nulls: 'last' } }
    });
  }

  async getClientUsers(clientId: string) {
    return prisma.user.findMany({
      where: { clientId },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        lastLoginAt: true,
        lastActiveAt: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async assumeClient(platformAdminId: string, clientId: string) {
    const userCount = await prisma.user.count({ where: { clientId } });
    if (userCount === 0) {
      throw new Error('Unknown client -- no users found for this clientId');
    }

    // Assuming a new client implicitly ends the previous impersonation; the UI keeps
    // only one sessionId in localStorage, so the old one would otherwise be unreachable.
    await this.endOpenSessionsForAdmin(platformAdminId);

    const session = await prisma.platformAdminSession.create({
      data: { platformAdminId, clientId }
    });

    return session;
  }

  // Closes any impersonation row still marked open for this admin. endAssumedSession
  // only ever fired from the "Exit to Console" button, so assuming a second client,
  // signing out, or just closing the tab left the previous row with endedAt = null --
  // badged ACTIVE forever in the Audit Log, and shown to the client's own team as
  // "a Scaleezy admin is currently inside your account".
  async endOpenSessionsForAdmin(platformAdminId: string) {
    return prisma.platformAdminSession.updateMany({
      where: { platformAdminId, endedAt: null },
      data: { endedAt: new Date() }
    });
  }

  async endAssumedSession(sessionId: string) {
    return prisma.platformAdminSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() }
    });
  }

  // Turns "Acme Boutique Pvt Ltd" into "acme-boutique-pvt-ltd", then disambiguates
  // against every clientId already known locally (derived from Users, same as
  // listClients -- there's no separate Client registry to check against).
  private async generateClientId(companyName: string) {
    const base = companyName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'client';

    const existing = new Set(
      (await prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } })).map(u => u.clientId)
    );

    if (!existing.has(base)) return base;

    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) suffix++;
    return `${base}-${suffix}`;
  }

  async onboardClient(companyName: string, adminName: string, adminEmail: string) {
    const clientId = await this.generateClientId(companyName);

    const tempPassword = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
    const hashed = await AuthService.hashPassword(tempPassword);
    // Same reversible-encryption scheme as Team & Users (team.service.ts) -- this account
    // is itself a team member of the new client, so its password should be viewable there
    // too, not just at the moment of onboarding.
    const passwordEncrypted = encryptCredential(tempPassword);

    const roleIds = await seedRolesForClient(clientId);
    await seedCatalogDefaultsForClient(clientId);

    // Every stock movement requires a locationId, and a freshly onboarded client had NO
    // locations at all -- so their very first product silently lost its opening stock:
    // variant.service's resolveInitialStockLocationIds returned [], applyInitialStock
    // looped over nothing, and the UI still reported "Product created successfully" while
    // the quantity went nowhere. That resolver already looks for exactly this code, so the
    // MAIN-STORE location was always the intended default -- onboarding just never made it.
    // Created here so a new workspace is usable the moment the client logs in; they can
    // rename it or add more under Settings -> Stock Locations.
    await prisma.stockLocation.create({
      data: { clientId, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true }
    });

    const user = await prisma.user.create({
      data: { clientId, name: adminName, email: adminEmail, password: hashed, passwordEncrypted, status: 'ACTIVE' }
    });

    await prisma.userRole.create({
      data: { userId: user.id, roleId: roleIds.SUPER_ADMIN }
    });

    // The shop owner's login is the last thing standing between onboarding and them actually
    // using the product, and until now it left this building by being read off a console
    // screen and typed into a message by hand.
    const delivery = await mailService.sendCredentials({
      recipientName: adminName, email: adminEmail, password: tempPassword, roleLabel: 'SUPER_ADMIN'
    });

    return { clientId, adminName, adminEmail, tempPassword, emailed: delivery.sent, emailReason: delivery.reason };
  }

  // ─── SUSPENDING AND DELETING A CLIENT ───────────────────────────────────────

  /**
   * Suspends a client: nobody in it can sign in, and nothing of theirs is touched.
   *
   * Reversible by design, and the reason it exists separately from deletion. Almost every real
   * reason to cut off access -- unpaid invoice, a dispute, suspected misuse -- is temporary,
   * and reaching for deletion in those cases destroys a shop's records to solve a billing
   * problem.
   *
   * Storefront connections are paused too. Leaving them running would mean a suspended shop's
   * website carrying on being updated with live stock, which is the opposite of suspended.
   */
  async setClientSuspended(clientId: string, suspended: boolean) {
    const status = suspended ? 'INACTIVE' : 'ACTIVE';

    const [users, connections] = await prisma.$transaction([
      prisma.user.updateMany({ where: { clientId }, data: { status } }),
      suspended
        ? prisma.storefrontConnection.updateMany({
            where: { clientId, status: 'ACTIVE' }, data: { status: 'DISABLED' }
          })
        // Reinstating deliberately does NOT switch storefronts back on. A connection may have
        // been paused by the merchant themselves before any of this, and turning it on for
        // them would publish stock they had chosen to stop publishing.
        : prisma.storefrontConnection.updateMany({ where: { id: '__none__' }, data: {} })
    ]);

    // Suspension is the button someone presses when they want a shop out now, so the cached
    // identities of everyone in it go immediately rather than at the end of their TTL.
    forgetClientIdentities(clientId);

    return { clientId, suspended, usersAffected: users.count, connectionsPaused: connections.count };
  }

  /** Whether every user in a client is currently deactivated. */
  async isClientSuspended(clientId: string) {
    const [total, active] = await Promise.all([
      prisma.user.count({ where: { clientId } }),
      prisma.user.count({ where: { clientId, status: 'ACTIVE' } })
    ]);
    return total > 0 && active === 0;
  }

  /**
   * What a deletion would destroy, counted before anyone confirms it.
   *
   * Shown on the confirmation screen. "Delete this client" is an abstraction; "1,204 products,
   * 87 orders and 3 staff accounts" is the actual consequence, and it is the last chance
   * anyone has to notice they are looking at the wrong tenant.
   */
  async previewClientDeletion(clientId: string) {
    const [users, products, variants, orders, purchaseOrders, locations, suppliers, transactions] =
      await Promise.all([
        prisma.user.count({ where: { clientId } }),
        prisma.product.count({ where: { clientId } }),
        prisma.productVariant.count({ where: { clientId } }),
        prisma.salesOrder.count({ where: { clientId } }),
        prisma.purchaseOrder.count({ where: { clientId } }),
        prisma.stockLocation.count({ where: { clientId } }),
        prisma.supplier.count({ where: { clientId } }),
        prisma.inventoryTransaction.count({ where: { variant: { clientId } } })
      ]);

    return { clientId, users, products, variants, orders, purchaseOrders, locations, suppliers, transactions };
  }

  /**
   * Erases a client completely.
   *
   * There is no undo, no soft delete and no tombstone: the row-level records are gone when this
   * returns. Two things make that survivable to implement.
   *
   * ONE TRANSACTION. Every statement commits together or none of them do. A half-deleted tenant
   * -- products gone, orders referencing them still present -- is worse than either outcome,
   * and would be unrecoverable without a backup.
   *
   * IT CHECKS ITSELF. Afterwards, and still inside the transaction, it asks the DATABASE which
   * tables have a client_id column and counts what is left for this client. Anything remaining
   * aborts the whole thing. That is what makes the operation survive schema growth: a table
   * added next year that nobody remembers to list here does not silently leave a residue, it
   * fails the delete loudly and someone fixes the order.
   *
   * The delete order is children before parents. Getting it wrong produces a foreign-key error
   * and a rollback, which is the correct failure -- noisy and harmless, never partial.
   */
  async deleteClientCompletely(clientId: string, confirmation: string) {
    // Belt and braces with the route's own check. This function erases a tenant; it should be
    // impossible to call it by accident from anywhere, including a future caller of our own.
    if (confirmation !== clientId) {
      throw Object.assign(
        new Error('The confirmation text does not match the client id'),
        { statusCode: 400 }
      );
    }

    // Before the rows go, so nothing can be served from a cached identity belonging to a
    // tenant that no longer exists.
    forgetClientIdentities(clientId);

    const exists = await prisma.user.count({ where: { clientId } });
    if (exists === 0) {
      const anything = await prisma.product.count({ where: { clientId } });
      if (anything === 0) {
        throw Object.assign(new Error('No such client, or it has already been deleted'), { statusCode: 404 });
      }
    }

    // Read before deleting: once the rows are gone so are the storage paths, and the images
    // would sit in Supabase forever with nothing pointing at them.
    const images = await prisma.productImage.findMany({
      where: { product: { clientId } },
      select: { storagePath: true }
    });
    const storagePaths = images.map(i => i.storagePath).filter((p): p is string => !!p);

    // Children first. Where a relation cascades this is redundant, and harmless; where it does
    // not, it is the difference between a clean delete and a foreign-key error.
    const statements: string[] = [
      // Storefront: deliveries reference both events and connections.
      `DELETE FROM storefront_deliveries WHERE client_id = $1`,
      `DELETE FROM storefront_events WHERE client_id = $1`,
      `DELETE FROM storefront_connections WHERE client_id = $1`,
      // Shopify: the children hang off the installation.
      `DELETE FROM shopify_inventory_echoes WHERE installation_id IN (SELECT id FROM shopify_installations WHERE client_id = $1)`,
      `DELETE FROM shopify_id_maps WHERE client_id = $1`,
      `DELETE FROM shopify_location_maps WHERE client_id = $1`,
      `DELETE FROM shopify_oauth_states WHERE client_id = $1`,
      `DELETE FROM shopify_installations WHERE client_id = $1`,
      // Reservations point at sales order items, so they go before the order chain.
      `DELETE FROM inventory_reservations WHERE client_id = $1`,
      `DELETE FROM dispatch_items WHERE dispatch_id IN (SELECT d.id FROM dispatches d JOIN sales_orders so ON so.id = d.sales_order_id WHERE so.client_id = $1)`,
      `DELETE FROM dispatches WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE client_id = $1)`,
      `DELETE FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE client_id = $1)`,
      `DELETE FROM sales_returns WHERE client_id = $1`,
      `DELETE FROM sales_order_items WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE client_id = $1)`,
      `DELETE FROM sales_orders WHERE client_id = $1`,
      `DELETE FROM sales_ledger WHERE client_id = $1`,
      `DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE client_id = $1)`,
      `DELETE FROM purchase_orders WHERE client_id = $1`,
      `DELETE FROM supplier_products WHERE client_id = $1`,
      `DELETE FROM suppliers WHERE client_id = $1`,
      `DELETE FROM inventory_stock_count_items WHERE stock_count_id IN (SELECT id FROM inventory_stock_counts WHERE client_id = $1)`,
      `DELETE FROM inventory_stock_counts WHERE client_id = $1`,
      `DELETE FROM inventory_transfers WHERE client_id = $1`,
      `DELETE FROM inventory_transactions WHERE client_id = $1`,
      `DELETE FROM inventory_events WHERE client_id = $1`,
      `DELETE FROM inventory_stocks WHERE client_id = $1`,
      `DELETE FROM variant_location_profiles WHERE variant_id IN (SELECT id FROM inventory_product_variants WHERE client_id = $1)`,
      `DELETE FROM inventory_alert_reads WHERE alert_id IN (SELECT id FROM inventory_alerts WHERE client_id = $1)`,
      `DELETE FROM inventory_alerts WHERE client_id = $1`,
      `DELETE FROM inventory_daily_location_snapshots WHERE client_id = $1`,
      `DELETE FROM inventory_daily_snapshots WHERE client_id = $1`,
      `DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = $1)`,
      `DELETE FROM inventory_product_variants WHERE client_id = $1`,
      `DELETE FROM inventory_products WHERE client_id = $1`,
      `DELETE FROM inventory_locations WHERE client_id = $1`,
      `DELETE FROM catalog_template_items WHERE template_id IN (SELECT id FROM inventory_label_templates WHERE client_id = $1)`,
      `DELETE FROM inventory_label_templates WHERE client_id = $1`,
      `DELETE FROM customers WHERE client_id = $1`,
      `DELETE FROM support_ticket_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE client_id = $1)`,
      `DELETE FROM support_tickets WHERE client_id = $1`,
      `DELETE FROM client_error_logs WHERE client_id = $1`,
      `DELETE FROM audit_logs WHERE client_id = $1`,
      `DELETE FROM platform_admin_sessions WHERE client_id = $1`,
      `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = $1)`,
      `DELETE FROM users WHERE client_id = $1`,
      `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE client_id = $1)`,
      `DELETE FROM roles WHERE client_id = $1`,
      `DELETE FROM client_settings WHERE client_id = $1`,
      // The one the first real deletion attempt found, because the check below refused to let
      // it finish. The sweep after these statements would now catch it anyway; it is listed
      // explicitly so the order stays readable rather than relying on the safety net.
      `DELETE FROM client_catalog_items WHERE client_id = $1`,
      `DELETE FROM inventory_client_sequences WHERE client_id = $1`
    ];

    // Sent to the database as ONE statement, and this is the whole reason for the DO block.
    //
    // Run as separate queries, these forty-eight deletes were forty-eight network round trips.
    // Against a database on another continent that is roughly a second each: a minute of
    // waiting for an operation that takes the database itself milliseconds. Inside a DO block
    // they run server-side, sequentially, in one trip.
    //
    // A DO block cannot take bound parameters, so the id is inlined -- which is why it is
    // validated to a strict character set first and quoted by format(%L) inside. Anything
    // outside that set is refused rather than escaped.
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) {
      throw Object.assign(
        new Error('That client id contains characters this operation will not accept'),
        { statusCode: 400 }
      );
    }

    const ordered = statements
      .map(s => s.replace(/\$1/g, `'${clientId}'`))
      .join(';\n  ');

    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        DO $$
        DECLARE t text;
        BEGIN
          ${ordered};

          -- Then sweep whatever the list above did not know about.
          --
          -- This is what stops the operation rotting. A table added to the schema next year is
          -- caught here rather than surviving as an orphaned row -- which is exactly what
          -- happened with client_catalog_items, discovered only because the check below
          -- refused to let the delete finish.
          --
          -- It runs AFTER the ordered statements, so by now the parents are gone and what is
          -- left is independent. If something still has a foreign key holding it, this fails
          -- and the whole transaction rolls back, which is the correct outcome.
          FOR t IN
            SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'client_id'
          LOOP
            EXECUTE format('DELETE FROM %I WHERE client_id = %L', t, '${clientId}');
          END LOOP;
        END $$;
      `);

      // The self-check, also one statement rather than one per table. Asks the database what
      // exists rather than trusting any list in this file.
      const leftovers = await tx.$queryRawUnsafe<{ table_name: string; remaining: bigint }[]>(`
        SELECT table_name, remaining FROM (
          SELECT c.table_name,
                 (xpath('/row/c/text()',
                   query_to_xml(format('SELECT COUNT(*) AS c FROM %I WHERE client_id = %L',
                                       c.table_name, '${clientId}'), false, true, '')
                 ))[1]::text::bigint AS remaining
          FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.column_name = 'client_id'
        ) counted
        WHERE remaining > 0
      `);

      if (leftovers.length > 0) {
        // Rolls everything back. A partial delete is the one outcome worth failing to avoid,
        // and this is the last place that can still catch it.
        const detail = leftovers.map(l => `${l.table_name} (${Number(l.remaining)})`).join(', ');
        throw new Error(
          `Deletion is incomplete -- rolled back, nothing was removed. Rows remain in: ${detail}.`
        );
      }
    }, {
      maxWait: 20_000,
      timeout: 120_000
    });

    // Only once the rows are certainly gone. Doing this first would delete a shop's photographs
    // and then fail the transaction, leaving records pointing at images that no longer exist.
    let imagesRemoved = 0;
    if (storagePaths.length > 0) {
      const { error } = await supabase.storage.from('inventory-images').remove(storagePaths);
      if (error) console.error(`[DeleteClient] ${storagePaths.length} images left in storage for ${clientId}:`, error);
      else imagesRemoved = storagePaths.length;
    }

    return { clientId, deleted: true, tablesCleared: statements.length, imagesRemoved };
  }

  // ─── PLATFORM ADMINS ────────────────────────────────────────────────────────
  //
  // Whoever is in this table can read and act on EVERY tenant's data. There is no hierarchy
  // among them -- any platform admin can add another -- so the guards here are about not
  // locking everyone out, and about not leaving a permanent decryptable copy of a key that
  // opens every shop.

  async listPlatformAdmins() {
    return prisma.platformAdmin.findMany({
      // No password field, encrypted or otherwise. Nothing here should ever be able to return
      // one, so it is excluded at the query rather than trusted to be dropped later.
      select: { id: true, name: true, email: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    });
  }

  /**
   * Adds a platform admin.
   *
   * The password is generated, shown once, and emailed. Unlike a shop user it is stored ONLY
   * as a bcrypt hash -- there is deliberately no reversible copy, so this password cannot be
   * viewed or re-sent later. A shop assistant's password protects one shop; this one opens
   * every tenant on the platform, and a decryptable copy of it sitting in a table is a far
   * larger prize. If the message is lost, issue a new password rather than recovering the old.
   */
  async createPlatformAdmin(params: { name: string; email: string; customPassword?: string }) {
    const email = params.email.trim().toLowerCase();

    if (params.customPassword && params.customPassword.length < 12) {
      throw Object.assign(
        new Error('A platform admin password must be at least 12 characters -- this account can see every tenant'),
        { statusCode: 400 }
      );
    }

    const existing = await prisma.platformAdmin.findUnique({ where: { email } });
    if (existing) {
      throw Object.assign(new Error('A platform admin with this email already exists'), { statusCode: 409 });
    }

    // Longer than the shop-staff default for the same reason as the check above.
    const password = params.customPassword || crypto.randomBytes(15).toString('base64url');
    const hashed = await AuthService.hashPassword(password);

    const admin = await prisma.platformAdmin.create({
      data: { name: params.name.trim(), email, password: hashed, status: 'ACTIVE' },
      select: { id: true, name: true, email: true, status: true, createdAt: true }
    });

    const delivery = await mailService.sendCredentials({
      recipientName: admin.name, email: admin.email, password,
      roleLabel: 'Platform Admin', audience: 'platform'
    });

    // Returned once. There is no second chance to read it -- see the note above.
    return { ...admin, password, emailed: delivery.sent, emailReason: delivery.reason };
  }

  /**
   * Activates or deactivates a platform admin.
   *
   * Refuses to deactivate the last active one. Without that check a single click locks
   * everybody out of the console permanently, and the only way back in is a database edit.
   */
  async setPlatformAdminStatus(params: { adminId: string; status: 'ACTIVE' | 'INACTIVE'; requesterId: string }) {
    if (params.adminId === params.requesterId && params.status !== 'ACTIVE') {
      throw Object.assign(new Error('You cannot deactivate your own account'), { statusCode: 400 });
    }

    const target = await prisma.platformAdmin.findUnique({ where: { id: params.adminId } });
    if (!target) throw Object.assign(new Error('Platform admin not found'), { statusCode: 404 });

    if (params.status !== 'ACTIVE') {
      const remaining = await prisma.platformAdmin.count({
        where: { status: 'ACTIVE', id: { not: params.adminId } }
      });
      if (remaining === 0) {
        throw Object.assign(
          new Error('This is the only active platform admin -- add another before deactivating this one'),
          { statusCode: 409 }
        );
      }
    }

    return prisma.platformAdmin.update({
      where: { id: params.adminId },
      data: { status: params.status },
      select: { id: true, name: true, email: true, status: true }
    });
  }

  /**
   * Issues a new password for a platform admin and emails it.
   *
   * This is what replaces "resend" for these accounts. The old password cannot be recovered,
   * so the honest operation is to replace it -- and the person is told, because their existing
   * password stops working the moment this runs.
   */
  async resetPlatformAdminPassword(params: { adminId: string; customPassword?: string }) {
    if (params.customPassword && params.customPassword.length < 12) {
      throw Object.assign(new Error('A platform admin password must be at least 12 characters'), { statusCode: 400 });
    }

    const target = await prisma.platformAdmin.findUnique({ where: { id: params.adminId } });
    if (!target) throw Object.assign(new Error('Platform admin not found'), { statusCode: 404 });

    const password = params.customPassword || crypto.randomBytes(15).toString('base64url');
    await prisma.platformAdmin.update({
      where: { id: params.adminId },
      data: { password: await AuthService.hashPassword(password) }
    });

    const delivery = await mailService.sendCredentials({
      recipientName: target.name, email: target.email, password,
      roleLabel: 'Platform Admin', audience: 'platform'
    });

    return {
      id: target.id, name: target.name, email: target.email, password,
      emailed: delivery.sent, emailReason: delivery.reason
    };
  }

  // Merges two independent event sources -- PlatformAdminSession (a super admin viewing a
  // client) and AuditLog (a real user's mutation inside their own tenant) -- into one
  // standardized, chronologically sorted feed. Each source keeps its own table and pruning
  // rules; this is purely a read-time projection.
  async listAuditLog(limit = 100) {
    return buildUnifiedAuditFeed({ limit });
  }

  async listClientErrors(limit = 100) {
    return prisma.clientErrorLog.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
  }

  async listAllSupportTickets() {
    return supportTicketService.listAllTickets();
  }

  async getSupportTicket(ticketId: string) {
    return supportTicketService.getTicket(ticketId);
  }

  async replyToSupportTicket(ticketId: string, adminName: string, body: string) {
    return supportTicketService.addMessage(ticketId, { authorType: 'PLATFORM_ADMIN', authorName: adminName, body });
  }

  async updateSupportTicketStatus(ticketId: string, status: string) {
    return supportTicketService.updateStatus(ticketId, status);
  }

  // The recovery path of last resort: a client's Team & Users deliberately blocks managing
  // your OWN row (see team.service.ts), so a client with exactly one Super Admin -- the
  // common case right after onboarding -- has no in-app way to recover if that person
  // forgets their password. A platform admin outranks every client role, so no hierarchy
  // guard applies here.
  async viewUserPassword(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (!user.passwordEncrypted) {
      throw Object.assign(new Error('No viewable password on file for this account -- set a new one instead'), { statusCode: 404 });
    }
    return { id: user.id, name: user.name, email: user.email, password: decryptCredential(user.passwordEncrypted) };
  }

  async setUserPassword(userId: string, customPassword?: string) {
    if (customPassword && customPassword.length < 6) {
      throw Object.assign(new Error('Password must be at least 6 characters'), { statusCode: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const finalPassword = customPassword || generateTempPassword();
    const [hashed, passwordEncrypted] = await Promise.all([
      AuthService.hashPassword(finalPassword),
      Promise.resolve(encryptCredential(finalPassword))
    ]);
    await prisma.user.update({ where: { id: userId }, data: { password: hashed, passwordEncrypted } });

    return { id: user.id, name: user.name, email: user.email, password: finalPassword };
  }
}

export const platformAdminService = new PlatformAdminService();
