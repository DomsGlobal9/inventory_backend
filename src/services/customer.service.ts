import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { CustomerStatus } from '@prisma/client';

export class CustomerService {
  async createCustomer(clientId: string, data: any) {
    const customerCode = await generateSequentialCode(clientId, 'CUS', 'CUSTOMER');
    return prisma.customer.create({
      data: {
        clientId,
        customerCode,
        name: data.name,
        companyName: data.companyName,
        phone: data.phone,
        email: data.email,
        gstNumber: data.gstNumber,
        billingAddress: data.billingAddress,
        shippingAddress: data.shippingAddress,
        status: data.status || 'ACTIVE',
      }
    });
  }

  async getCustomers(clientId: string, filters: any = {}) {
    const where: any = { clientId, deletedAt: null };
    
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { customerCode: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    
    if (filters.status) {
      where.status = filters.status;
    }

    return prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });
  }

  async getCustomerById(clientId: string, id: string) {
    const customer = await prisma.customer.findFirst({
      where: { clientId, id, deletedAt: null },
      include: {
        salesOrders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          // The Dispatches tab derives its list from customer.salesOrders[i].dispatches,
          // and the "Create Return Request" flow then reads dispatch.items to work out
          // what's still returnable -- both were undefined before, so the tab showed
          // "No dispatches" for everyone and the return button threw on .filter().
          include: { dispatches: { include: { items: true } } }
        }
      }
    });

    if (!customer) {
      throw new Error(`Customer ${id} not found`);
    }

    return customer;
  }

  async updateCustomer(clientId: string, id: string, data: any) {
    // Ensure customer belongs to client
    const existing = await prisma.customer.findFirst({ where: { clientId, id } });
    if (!existing) throw new Error('Customer not found');

    return prisma.customer.update({
      where: { id },
      data: {
        name: data.name,
        companyName: data.companyName,
        phone: data.phone,
        email: data.email,
        gstNumber: data.gstNumber,
        billingAddress: data.billingAddress,
        shippingAddress: data.shippingAddress,
        status: data.status,
      }
    });
  }
}

export const customerService = new CustomerService();
