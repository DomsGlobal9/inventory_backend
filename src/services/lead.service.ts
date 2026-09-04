import { LeadStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { platformAdminService } from './platform-admin.service';

/**
 * Signup enquiries from the public marketing form.
 *
 * The deliberate constraint here is that submitting the form provisions NOTHING -- no
 * client, no workspace, no login, no roles. It writes one row. Everything that creates a
 * tenant stays behind the platform admin's authentication and happens at convert() time,
 * which is what stops an unauthenticated endpoint being usable to spawn workspaces.
 */
export class LeadService {
  async create(data: {
    companyName: string;
    contactName: string;
    email: string;
    phone: string;
    message?: string;
    sourceIp?: string;
    userAgent?: string;
  }) {
    const lead = await prisma.signupLead.create({
      data: {
        companyName: data.companyName.trim(),
        contactName: data.contactName.trim(),
        email: data.email.trim().toLowerCase(),
        phone: data.phone.trim(),
        message: data.message?.trim() || null,
        sourceIp: data.sourceIp || null,
        userAgent: data.userAgent?.slice(0, 500) || null
      }
    });

    // The caller is anonymous, so it is told only that the enquiry landed. Returning the
    // row would hand a stranger our ids and let them enumerate what we hold.
    return { id: lead.id };
  }

  async list(params: { status?: LeadStatus; search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 25));

    const where: Prisma.SignupLeadWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.search?.trim()) {
      const q = params.search.trim();
      where.OR = [
        { companyName: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } }
      ];
    }

    const [items, total, counts] = await Promise.all([
      prisma.signupLead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.signupLead.count({ where }),
      // Board counts are over ALL leads, not the current filter -- they are the thing you
      // use to pick a filter, so narrowing them by the active one makes them useless.
      prisma.signupLead.groupBy({ by: ['status'], _count: { id: true } })
    ]);

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        countsByStatus: Object.fromEntries(counts.map(c => [c.status, c._count.id]))
      }
    };
  }

  async update(id: string, data: { status?: LeadStatus; notes?: string }) {
    const lead = await prisma.signupLead.findUnique({ where: { id } });
    if (!lead) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });

    // CONVERTED is set by convert() alongside the workspace it produced. Allowing it to be
    // set by hand would claim a workspace exists with no convertedClientId to point at.
    if (data.status === LeadStatus.CONVERTED) {
      throw Object.assign(
        new Error('Use the convert action to onboard this lead -- it creates the workspace and credentials.'),
        { statusCode: 400 }
      );
    }

    return prisma.signupLead.update({
      where: { id },
      data: {
        ...(data.status ? { status: data.status } : {}),
        ...(data.notes !== undefined ? { notes: data.notes.trim() || null } : {})
      }
    });
  }

  /**
   * Accepts the lead and runs the ordinary onboarding, returning the same credential payload
   * the Onboarding screen produces. Guarded against double-conversion, which would otherwise
   * create a second workspace and orphan the first.
   */
  async convert(id: string, overrides?: { companyName?: string; adminName?: string; adminEmail?: string }) {
    const lead = await prisma.signupLead.findUnique({ where: { id } });
    if (!lead) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    if (lead.status === LeadStatus.CONVERTED) {
      throw Object.assign(
        new Error(`This lead was already converted to workspace "${lead.convertedClientId}".`),
        { statusCode: 409 }
      );
    }

    const result = await platformAdminService.onboardClient(
      overrides?.companyName?.trim() || lead.companyName,
      overrides?.adminName?.trim() || lead.contactName,
      overrides?.adminEmail?.trim() || lead.email
    );

    // Recorded after onboarding succeeds: marking it converted first would strand the lead
    // in a state claiming a workspace that was never created.
    await prisma.signupLead.update({
      where: { id },
      data: {
        status: LeadStatus.CONVERTED,
        convertedClientId: result.clientId,
        convertedAt: new Date()
      }
    });

    return result;
  }
}

export const leadService = new LeadService();
